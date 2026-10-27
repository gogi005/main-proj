import { IsString, Matches, IsEnum, IsOptional } from 'class-validator';
import { Role } from '@prisma/client';

const E164 = /^\+[1-9]\d{7,14}$/;

export class RequestOtpDto {
  @Matches(E164, { message: 'phone must be E.164, e.g. +15551234567' })
  phone!: string;
}

export class VerifyOtpDto {
  @Matches(E164)
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;

  /** Opaque id returned by /auth/otp/request — binds verification to one challenge. */
  @IsString()
  challengeId!: string;
}

export class RegisterDto {
  @Matches(E164)
  phone!: string;

  @IsString()
  fullName!: string;

  /**
   * SECURITY: role is NOT accepted from the client on public registration.
   * New users are always PENDING_VERIFICATION WORKERs until STAFF assigns a
   * role/project via `user:manage`. This field only exists for admin-created
   * accounts (guarded route re-uses this DTO after stripping via whitelist).
   */
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class LogoutDto {
  @IsString()
  refreshToken!: string;
}

export class RegisterPushTokenDto {
  @IsString()
  fcmToken!: string;

  @IsString()
  platform!: string; // ios | android
}
