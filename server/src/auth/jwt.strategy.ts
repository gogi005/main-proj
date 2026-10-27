import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { PrismaClient, UserStatus } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
  role: string;
  jti: string;
  typ: 'access';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaClient,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Validates signature/expiry (passport) then checks live account state —
   * a suspended user's unexpired token is rejected immediately.
   */
  async validate(payload: JwtPayload): Promise<{ id: string; role: never; jti: string }> {
    if (payload.typ !== 'access') {
      throw new UnauthorizedException({ error: 'WRONG_TOKEN_TYPE' });
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException({ error: 'ACCOUNT_INACTIVE' });
    }
    return { id: user.id, role: user.role as never, jti: payload.jti };
  }
}
