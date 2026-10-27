import { Module } from '@nestjs/common';
import { NotificationDispatcher } from './notification.dispatcher';
import { NotificationService } from './notification.service';

@Module({
  providers: [NotificationService, NotificationDispatcher],
  exports: [NotificationService],
})
export class NotificationsModule {}
