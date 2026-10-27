import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ModerationStatus, PhotoSubjectType, Role } from '@prisma/client';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { JwtPermissionsGuard } from '../common/guards/jwt-permissions.guard';
import { PhotosService } from './photos.service';
import { CompleteUploadDto, ModeratePhotoDto, PresignUploadDto } from './photo.dto';

/**
 * Two-step photo pipeline (spec §3): presign → direct PUT to S3 → complete.
 * The server mints object keys and signed URLs; raw objects are never public.
 */
@Controller('api/v1')
@UseGuards(JwtPermissionsGuard, ThrottlerGuard)
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Post('photos/presign')
  @RequirePermissions('photo:upload')
  presign(@CurrentUser() user: AuthenticatedUser, @Body() dto: PresignUploadDto) {
    return this.photos.presign({ id: user.id }, dto);
  }

  /**
   * Completion callback. Metadata is re-validated against the presign record
   * by key prefix — a client cannot attach arbitrary project/mime after the fact.
   */
  @Post('photos/complete')
  @RequirePermissions('photo:upload')
  complete(@CurrentUser() user: AuthenticatedUser, @Body() body: CompleteUploadDto & PresignUploadDto) {
    // Key was generated under photos/<projectId>/... — enforce it matches claimed project.
    if (!body.s3Key.startsWith(`photos/${body.projectId}/`)) {
      throw new ForbiddenException({ error: 'KEY_PROJECT_MISMATCH' });
    }
    const meta = {
      mimeType: body.mimeType,
      byteSize: body.byteSize,
      takenAt: body.takenAt,
      projectId: body.projectId,
      requestId: body.requestId,
      subjectType: body.subjectType as PhotoSubjectType,
    };
    return this.photos.complete({ id: user.id }, { s3Key: body.s3Key }, meta);
  }

  @Get('projects/:id/photos')
  @RequirePermissions('photo:view:project')
  gallery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') projectId: string,
    @Query('status') status?: ModerationStatus,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.photos.listForProject(
      { id: user.id, role: user.role as Role },
      projectId,
      { status, page: Number(page) || undefined, pageSize: Number(pageSize) || undefined },
    );
  }

  // ─────────────── STAFF moderation queue ───────────────

  @Get('moderation/queue')
  @RequirePermissions('photo:moderate')
  queue(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.photos.pendingQueue({ page: Number(page) || undefined, pageSize: Number(pageSize) || undefined });
  }

  @Post('moderation/:photoId/approve')
  @RequirePermissions('photo:moderate')
  approve(@CurrentUser() user: AuthenticatedUser, @Param('photoId') photoId: string) {
    return this.photos.approve({ id: user.id, role: user.role as Role }, photoId);
  }

  @Post('moderation/:photoId/reject')
  @RequirePermissions('photo:moderate')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('photoId') photoId: string,
    @Body() dto: ModeratePhotoDto,
  ) {
    return this.photos.reject({ id: user.id, role: user.role as Role }, photoId, dto);
  }
}
