import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtPermissionsGuard } from '../common/guards/jwt-permissions.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { LogoutDto, RefreshDto, RegisterDto, RegisterPushTokenDto, RequestOtpDto, VerifyOtpDto } from './dto/auth.dto';
import { NotificationService } from '../notifications/notification.service';

/**
 * Public surface is only OTP + refresh; everything else requires a valid access token.
 * OTP endpoints are rate-limited per IP to blunt SMS-pumping / brute force.
 */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly notifications: NotificationService,
  ) {}

  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } }) // 3 requests/min/IP
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  @Post('otp/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code, dto.challengeId);
  }

  @Post('register')
  register(@Body() dto: RegisterDto) {
    // dto.role intentionally ignored here — public signup cannot self-assign roles.
    return this.auth.register(dto.phone, dto.fullName);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.rotateRefresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtPermissionsGuard)
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtPermissionsGuard)
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.getProfile(user.id);
  }

  /** Stores the FCM device token for push fan-out (approval alerts, moderation results). */
  @Post('push-token')
  @HttpCode(201)
  @UseGuards(JwtPermissionsGuard)
  registerPushToken(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterPushTokenDto) {
    return this.notifications.registerDeviceToken(user.id, dto.fcmToken, dto.platform);
  }
}
