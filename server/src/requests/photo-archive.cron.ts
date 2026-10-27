import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PhotosService } from './photos.service';

/** Nightly purge of rejected photos past their 7-day retention window. */
@Injectable()
export class PhotoArchiveCron {
  private readonly logger = new Logger(PhotoArchiveCron.name);

  constructor(private readonly photos: PhotosService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async archive(): Promise<void> {
    try {
      const n = await this.photos.archiveExpired();
      if (n > 0) this.logger.log(`Archived ${n} expired rejected photos`);
    } catch (err) {
      this.logger.error(`Photo archive cron failed: ${(err as Error).message}`);
    }
  }
}
