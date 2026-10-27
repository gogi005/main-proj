import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from './notification.service';

/**
 * Outbox dispatcher loop. Runs every 15s; each tick drains up to a batch of
 * PENDING rows. Safe under horizontal scaling because a row flips to
 * DISPATCHED atomically after push — worst case (two replicas racing) is a
 * duplicate push, which the client dedupes on notification id. Move to
 * SELECT ... FOR UPDATE SKIP LOCKED (via $queryRaw) if replicas grow.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private running = false;

  constructor(private readonly notifications: NotificationService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async drain(): Promise<void> {
    if (this.running) return; // no overlapping ticks
    this.running = true;
    try {
      const n = await this.notifications.dispatchPendingOutbox();
      if (n > 0) this.logger.debug(`Dispatched ${n} outbox notifications`);
    } catch (err) {
      this.logger.error(`Outbox drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
