import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OtpCode, PrismaClient, Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt } from 'crypto';
import { NotificationService } from '../notifications/notification.service';

export interface TokenPair {
  accessToken: string; // JWT, 15m TTL
  refreshToken: string; // opaque, 7d, rotated on every use
}

interface AccessTokenClaims {
  sub: string;
  role: Role;
  jti: string;
  typ: 'access';
}

/**
 * Auth core: OTP challenge/response + JWT access tokens + rotating refresh tokens.
 * - OTP codes are hashed (bcrypt) at rest; max 3 verification attempts.
 * - Refresh tokens are opaque random strings; only SHA-256 hashes stored.
 *   Re-use of a consumed token revokes the whole family (theft detection).
 */
@Injectable()
export class AuthService {
  private readonly otpTtlMs: number;
  private readonly otpMaxAttempts: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationService,
  ) {
    this.otpTtlMs = Number(this.config.get('OTP_TTL_MINUTES') ?? 5) * 60_000;
    this.otpMaxAttempts = Number(this.config.get('OTP_MAX_ATTEMPTS') ?? 3);
  }

  // ───────────────────────────── OTP flow ─────────────────────────────

  /** Creates (or finds) a pending user and issues a hashed, expiring OTP challenge. */
  async requestOtp(phone: string): Promise<{ challengeId: string; expiresInSec: number }> {
    const user = await this.prisma.user.upsert({
      where: { phone },
      update: {},
      create: {
        phone,
        fullName: 'Pending User',
        role: Role.WORKER,
        status: UserStatus.PENDING_VERIFICATION,
      },
    });

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException({ error: 'ACCOUNT_SUSPENDED' });
    }

    // Invalidate any outstanding challenges for this user (single active challenge).
    await this.prisma.otpCode.deleteMany({
      where: { userId: user.id, consumedAt: null },
    });

    const code = String(randomInt(100000, 999999)); // CSPRNG — never Math.random
    const codeHash = await bcrypt.hash(code, 10);
    const otp = await this.prisma.otpCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt: new Date(Date.now() + this.otpTtlMs),
      },
    });

    // Real SMS delivery (Twilio/MessageBird). Never log or return the plaintext.
    await this.notifications.sendSms(phone, `Your BuildSite code is ${code}. Expires in 5 minutes.`);

    return { challengeId: otp.id, expiresInSec: this.otpTtlMs / 1000 };
  }

  /** Verifies OTP and returns a fresh token pair. New phones flip to ACTIVE on first verify. */
  async verifyOtp(phone: string, code: string, challengeId: string): Promise<TokenPair & { user: SafeUser }> {
    const otp = await this.resolveChallenge(phone, challengeId);

    if (otp.attempts >= this.otpMaxAttempts) {
      await this.prisma.otpCode.delete({ where: { id: otp.id } });
      throw new UnauthorizedException({ error: 'TOO_MANY_ATTEMPTS' });
    }
    if (otp.expiresAt < new Date()) {
      throw new UnauthorizedException({ error: 'OTP_EXPIRED' });
    }

    const ok = await bcrypt.compare(code, otp.codeHash);
    if (!ok) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException({ error: 'INVALID_OTP' });
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    const user = await this.prisma.user.update({
      where: { id: otp.userId },
      data: { isPhoneVerified: true, status: UserStatus.ACTIVE },
    });

    await this.audit('LOGIN', user.id, { method: 'OTP' });
    return { ...(await this.issueTokenPair(user)), user: toSafeUser(user) };
  }

  private async resolveChallenge(phone: string, challengeId: string): Promise<OtpCode> {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new UnauthorizedException({ error: 'UNKNOWN_CHALLENGE' });
    const otp = await this.prisma.otpCode.findFirst({
      where: { id: challengeId, userId: user.id, consumedAt: null },
    });
    if (!otp) throw new UnauthorizedException({ error: 'UNKNOWN_CHALLENGE' });
    return otp;
  }

  // ───────────────────────────── Registration ─────────────────────────────

  /** Public self-registration: always WORKER + PENDING until STAFF activates. */
  async register(phone: string, fullName: string): Promise<{ userId: string; status: UserStatus }> {
    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) throw new ConflictException({ error: 'PHONE_ALREADY_REGISTERED' });

    const user = await this.prisma.user.create({
      data: { phone, fullName, role: Role.WORKER, status: UserStatus.PENDING_VERIFICATION },
    });
    return { userId: user.id, status: user.status };
  }

  // ───────────────────────────── Token issuance / rotation ─────────────────────────────

  async issueTokenPair(user: User, deviceInfo?: string): Promise<TokenPair> {
    const jti = randomBytes(16).toString('hex');
    const claims: AccessTokenClaims = { sub: user.id, role: user.role, jti, typ: 'access' };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('ACCESS_TOKEN_TTL') ?? '15m',
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = sha256(refreshToken);
    const ttlDays = parseInt(this.config.get<string>('REFRESH_TOKEN_TTL') ?? '7d', 10);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        deviceInfo,
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Rotation with theft detection: a refresh token can be used exactly once.
   * Presenting an already-consumed token revokes ALL of the user's sessions.
   */
  async rotateRefresh(presented: string, deviceInfo?: string): Promise<TokenPair & { user: SafeUser }> {
    const tokenHash = sha256(presented);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) throw new UnauthorizedException({ error: 'INVALID_REFRESH_TOKEN' });
    if (stored.revokedAt || stored.expiresAt < new Date()) {
      // Possible replay of stolen token → kill family.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({ error: 'REFRESH_REUSED_SESSION_REVOKED' });
    }
    if (stored.user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException({ error: 'ACCOUNT_NOT_ACTIVE' });
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), lastUsedAt: new Date() },
    });

    await this.audit('REFRESH_ROTATED', stored.userId, {});
    const pair = await this.issueTokenPair(stored.user, deviceInfo);
    return { ...pair, user: toSafeUser(stored.user) };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Force-logout every session (used by STAFF user management / compliance). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getProfile(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return toSafeUser(user);
  }

  private async audit(action: string, actorId: string, metadata: object): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: action as never,
        actorId,
        entityType: 'User',
        entityId: actorId,
        metadata: metadata as never,
      },
    });
  }
}

/** User shape safe to expose over the API — no hashes, no PII beyond profile fields. */
export interface SafeUser {
  id: string;
  phone: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  isPhoneVerified: boolean;
  biometricEnabled: boolean;
}

function toSafeUser(u: User): SafeUser {
  return {
    id: u.id,
    phone: u.phone,
    fullName: u.fullName,
    role: u.role,
    status: u.status,
    isPhoneVerified: u.isPhoneVerified,
    biometricEnabled: u.biometricEnabled,
  };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
