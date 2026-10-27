import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, PrismaClient, Role } from '@prisma/client';
import * as admin from 'firebase-admin';
import { Twilio } from 'twilio';

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link consumed by Expo Router: e.g. { screen: "requests/[id]", params: { id } } */
  data: Record<string, string>;
}

/**
 * Outbound fan-out:
 * - FCM push for ACTION_REQUIRED / ALERT types (real-time operator nudges).
 * - SMS via Twilio strictly for OTP (kept separate so business pushes never cost SMS).
 * Notifications are also persisted (OutboundNotification) so the in-app inbox is
 * the source of truth even if a device is offline.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly fcmReady: boolean;
  private twilio?: Twilio;

  constructor(
    private readonly prisma: PrismaClient,
    config: ConfigService,
  ) {
    // firebase-admin auto-discovers GOOGLE_APPLICATION_CREDENTIALS.
    try {
      if (!admin.apps.length) {
        admin.initializeApp({ projectId: config.get('FCM_PROJECT_ID') });
      }
      this.fcmReady = true;
    } catch (err) {
      this.fcmReady = false;
      this.logger.warn(`FCM disabled (no credentials): ${(err as Error).message}`);
    }

    const sid = config.get('TWILIO_ACCOUNT_SID');
    const token = config.get('TWILIO_AUTH_TOKEN');
    if (sid && token) {
      this.twilio = new Twilio(sid, token);
    }
  }

  async registerDeviceToken(userId: string, fcmToken: string, platform: string): Promise<void> {
    await this.prisma.notificationDevice.upsert({
      where: { fcmToken },
      update: { userId, platform, active: true },
      create: { userId, fcmToken, platform, active: true },
    });
  }

  /** Persist + push to one user. Returns silently on unknown recipients (privacy). */
  async notifyUser(
    recipientId: string,
    type: NotificationType,
    payload: PushPayload,
  ): Promise<void> {
    await this.prisma.outboundNotification.create({
      data: {
        recipientId,
        type,
        title: payload.title,
        body: payload.body,
        dataJson: payload.data as never,
      },
    });

    if (!this.fcmReady) return;
    const devices = await this.prisma.notificationDevice.findMany({
      where: { userId: recipientId, active: true },
    });
    if (devices.length === 0) return;

    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens: devices.map((d) => d.fcmToken),
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        apns: { payload: { aps: { sound: 'default', mutableContent: true } } },
        android: { priority: type === 'ACTION_REQUIRED' ? 'high' : 'normal' },
      });
      // Deactivate tokens rejected by FCM (uninstalled apps).
      const deadTokens = res.responses
        .map((r, i) => (r.success ? null : { r, token: devices[i]!.fcmToken }))
        .filter((x) => x && x.r.error?.code === 'messaging/registration-token-not-registered')
        .map((x) => x!.token);
      if (deadTokens.length > 0) {
        await this.prisma.notificationDevice.updateMany({
          where: { fcmToken: { in: deadTokens } },
          data: { active: false },
        });
      }
    } catch (err) {
      this.logger.error(`FCM send failed: ${(err as Error).message}`);
    }
  }

  /** Fan-out to all ACTIVE users holding any of `roles`, optionally scoped to project members. */
  async notifyRoleHolders(
    roles: Role[],
    payload: PushPayload,
    type: NotificationType,
    projectId?: string,
  ): Promise<void> {
    const recipients = await this.prisma.user.findMany({
      where: {
        role: { in: roles },
        status: 'ACTIVE',
        ...(projectId ? { projectMemberships: { some: { projectId } } } : {}),
      },
      select: { id: true },
    });
    await Promise.allSettled(
      recipients.map((r) => this.notifyUser(r.id, type, payload)),
    );
  }

  /** OTP delivery over SMS. Throws if the provider is not configured (fail loudly, never silently). */
  async sendSms(to: string, body: string): Promise<void> {
    if (!this.twilio) {
      throw new Error('SMS provider not configured (TWILIO_* env vars missing)');
    }
    await this.twilio.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER ?? '', body });
  }
}
