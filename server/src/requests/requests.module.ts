import { Module } from '@nestjs/common';
import { ApprovalEngineService } from './approval-engine.service';
import { PhotoArchiveCron } from './photo-archive.cron';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';
import { RequestsController } from './requests.controller';
import { RequestsService } from './requests.service';

@Module({
  controllers: [RequestsController, PhotosController],
  providers: [RequestsService, ApprovalEngineService, PhotosService, PhotoArchiveCron],
  exports: [RequestsService],
})
export class RequestsModule {}
