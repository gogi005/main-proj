import { Global, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, OutboxStatus, PrismaClient, Role } from '@prisma/client';
import * as admin from 'firebase-admin';
import { Twilio } from 'twilio';

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link consumed by Expo Router: e.g. { screen: "requests/[id]", params: { id } } */
  data: Record<string, string>;
}

/** Row shape accepted by the transactional outbox (created inside business txs). */
export interface OutboxRowInput {
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string;
  dataJson: Record<string, string>;
}

/**
 * Outbound fan-out — TRANSACTIONAL OUTBOX pattern:
 *  - Business transactions enqueue rows into NotificationOutbox atomically
 *    (enqueueTx), so a committed change ALWAYS yields a notification intent and
 *    a rolled-back change never sends one.
 *  - A cron dispatcher drains PENDING rows → FCM with bounded retries; the
 *    in-app inbox row (OutboundNotification) is written at dispatch time, so
 *    the persisted inbox mirrors what was actually pushed.
 *  - SMS via Twilio strictly for OTP (business pushes never cost SMS).
 * @Global so feature modules (requests/photos/users) can inject it without
 * re-importing NotificationsModule everywhere.
 */
@Global()
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

  // ─────────────────────── Outbox enqueue (inside business tx) ───────────────────────

  /** Enqueue ONE row using the caller's transaction client — atomic with the mutation. */
  async enqueueTx(tx: PrismaClient, input: OutboxRowInput): Promise<void> {
    await tx.notificationOutbox.create({
      data: {
        recipientId: input.recipientId,
        type: input.type,
        title: input.title,
        body: input.body,
        dataJson: input.dataJson as never,
      },
    });
  }

  /** Project-scoped recipients holding any of `roles`. */
  async resolveRoleRecipients(roles: Role[], projectId?: string): Promise<string[]> {
    const recipients = await this.prisma.user.findMany({
      where: {
        role: { in: roles },
        status: 'ACTIVE',
        ...(projectId ? { projectMemberships: { some: { projectId } } } : {}),
      },
      select: { id: true },
    });
    return recipients.map((r) => r.id);
  }

  /**
   * Resolve role recipients (optionally project-scoped) and enqueue rows on the
   * DEFAULT client. Callers that need strict atomicity should use enqueueTx per
   * recipient inside their SERIALIZABLE transaction instead.
   */
  async enqueueForRoles(
    roles: Role[],
    type: NotificationType,
    payload: PushPayload,
    projectId?: string,
  ): Promise<number> {
    const ids = await this.resolveRoleRecipients(roles, projectId);
    if (ids.length === 0) return 0;
    await this.prisma.notificationOutbox.createMany({
      data: ids.map((recipientId) => ({
        recipientId,
        type,
        title: payload.title,
        body: payload.body,
        dataJson: payload.data as never,
      })),
    });
    return ids.length;
  }

  /** Direct enqueue for a single recipient (post-commit, non-critical paths). */
  async enqueueForUser(recipientId: string, type: NotificationType, payload: PushPayload): Promise<void> {
    await this.prisma.notificationOutbox.create({
      data: {
        recipientId,
        type,
        title: payload.title,
        body: payload.body,
        dataJson: payload.data as never,
      },
    });
  }

  // ─────────────────────── Dispatcher (drained by cron) ───────────────────────

  /**
   * Drain pending outbox rows. At-least-once delivery: a row flips to DISPATCHED
   * only after FCM accepts; failures increment attempts and are retried until a
   * cap, then marked FAILED for alerting. Idempotency lives client-side
   * (notification ids in `data`) so duplicate pushes are harmless.
   */
  async dispatchPendingOutbox(batchSize = 50, maxAttempts = 5): Promise<number> {
    const rows = await this.prisma.notificationOutbox.findMany({
      where: { status: OutboxStatus.PENDING, attempts: { lt: maxAttempts } },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
    let dispatched = 0;
    for (const row of rows) {
      try {
        await this.pushToDevice(row.recipientId, {
          title: row.title,
          body: row.body,
          data: row.dataJson as unknown as Record<string, string>,
        });
        await this.prisma.$transaction([
          this.prisma.notificationOutbox.update({
            where: { id: row.id },
            data: { status: OutboxStatus.DISPATCHED, dispatchedAt: new Date(), attempts: { increment: 1 } },
          }),
          // In-app inbox mirror — source of truth when devices are offline.
          this.prisma.outboundNotification.create({
            data: {
              recipientId: row.recipientId,
              type: row.type,
              title: row.title,
              body: row.body,
              dataJson: row.dataJson as never,
              deliveredAt: new Date(),
            },
          }),
        ]);
        dispatched++;
      } catch (err) {
        const attempts = row.attempts + 1;
        await this.prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: (err as Error).message.slice(0, 500),
            status: attempts >= maxAttempts ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          },
        });
      }
    }
    return dispatched;
  }

  // ─────────────────────── Device registry & direct push ───────────────────────

  async registerDeviceToken(userId: string, fcmToken: string, platform: string): Promise<void> {
    await this.prisma.notificationDevice.upsert({
      where: { fcmToken },
      update: { userId, platform, active: true },
      create: { userId, fcmToken, platform, active: true },
    });
  }

  /** FCM-only push (no persistence). Used by the dispatcher. Throws on failure. */
  private async pushToDevice(recipientId: string, payload: PushPayload): Promise<void> {
    if (!this.fcmReady) return; // dev environments without credentials: no-op
    const devices = await this.prisma.notificationDevice.findMany({
      where: { userId: recipientId, active: true },
    });
    if (devices.length === 0) return;

    const res = await admin.messaging().sendEachForMulticast({
      tokens: devices.map((d) => d.fcmToken),
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
      apns: { payload: { aps: { sound: 'default', mutableContent: true } } },
      android: { priority: 'high' },
    });
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
  }

  /** Convenience: enqueue for one user (persisted via outbox, pushed by dispatcher). */
  async notifyUser(
    recipientId: string,
    type: NotificationType,
    payload: PushPayload,
  ): Promise<void> {
    await this.enqueueForUser(recipientId, type, payload);
  }

  /** OTP delivery over SMS. Throws if the provider is not configured (fail loudly, never silently). */
  async sendSms(to: string, body: string): Promise<void> {
    if (!this.twilio) {
      throw new Error('SMS provider not configured (TWILIO_* env vars missing)');
    }
    await this.twilio.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER ?? '', body });
  }
}
