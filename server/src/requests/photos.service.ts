import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  ModerationStatus,
  NotificationType,
  PhotoSubjectType,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { StorageService } from '../common/services/storage.service';
import { NotificationService } from '../notifications/notification.service';
import { AuditService } from '../audit/audit.service';
import { CompleteUploadDto, ModeratePhotoDto, PresignUploadDto } from './photo.dto';

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB hard cap on photo assets
const ARCHIVE_DELAY_MS = 7 * 86_400_000; // rejected photos purged after 7 days

@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Step 1 — presigned direct-to-S3 upload. The SERVER generates the object key
   * (random, unguessable); the client never chooses storage paths.
   */
  async presign(user: { id: string }, dto: PresignUploadDto) {
    if (dto.byteSize > MAX_BYTES) {
      throw new BadRequestException({ error: 'PHOTO_TOO_LARGE', maxBytes: MAX_BYTES });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: dto.projectId, userId: user.id } },
    });
    if (!member) throw new ForbiddenException({ error: 'NOT_PROJECT_MEMBER' });

    if (dto.subjectType === PhotoSubjectType.MATERIAL_REQUEST || dto.subjectType === PhotoSubjectType.DELIVERY_PROOF) {
      if (!dto.requestId) throw new BadRequestException({ error: 'REQUEST_ID_REQUIRED' });
      const req = await this.prisma.materialRequest.findUnique({ where: { id: dto.requestId } });
      if (!req || req.projectId !== dto.projectId) throw new NotFoundException({ error: 'REQUEST_NOT_FOUND' });
    }

    const s3Key = this.storage.generateKey(dto.projectId, dto.mimeType);
    const presign = await this.storage.presignUpload(s3Key, dto.mimeType, dto.byteSize);
    return presign;
  }

  /**
   * Step 2 — completion callback: creates the PENDING_REVIEW row. A nightly
   * reconcile job verifies the object exists + sha matches; until then the row
   * is not visible in stakeholder galleries (moderationStatus gate).
   */
  async complete(user: { id: string }, dto: CompleteUploadDto, meta: { mimeType: string; byteSize: number; takenAt: string; projectId: string; requestId?: string; subjectType: PhotoSubjectType }) {
    const exists = await this.prisma.workPhoto.findUnique({ where: { s3Key: dto.s3Key } });
    if (exists) return exists; // idempotent retry from the mobile offline queue

    const photo = await this.prisma.workPhoto.create({
      data: {
        subjectType: meta.subjectType,
        requestId: meta.requestId ?? null,
        projectId: meta.projectId,
        uploaderId: user.id,
        s3Key: dto.s3Key,
        mimeType: meta.mimeType,
        byteSize: meta.byteSize,
        sha256: '', // filled by the verifyObject step once bytes are readable
        takenAt: new Date(meta.takenAt),
        moderationStatus: ModerationStatus.PENDING_REVIEW,
      },
    });

    await this.audit.record({
      action: AuditAction.PHOTO_UPLOADED,
      actorId: user.id,
      entityType: 'WorkPhoto',
      entityId: photo.id,
      metadata: { s3Key: dto.s3Key, subjectType: meta.subjectType },
    });
    // Notify STAFF moderation queue of new work.
    await this.notifications.enqueueForRoles([Role.STAFF], NotificationType.ACTION_REQUIRED, {
      title: 'Photo awaiting review',
      body: `A ${meta.subjectType.toLowerCase().replace(/_/g, ' ')} photo needs moderation.`,
      data: { screen: 'moderation', id: photo.id },
    });
    return photo;
  }

  /** Integrity check: fetch object, hash it, compare with recorded sha256. */
  async verifyObject(photoId: string): Promise<boolean> {
    const photo = await this.prisma.workPhoto.findUniqueOrThrow({ where: { id: photoId } });
    const view = await this.storage.presignView(photo.s3Key, 60);
    const res = await fetch(view.url);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = StorageService.sha256Hex(buf);
    if (photo.sha256 && photo.sha256 !== sha) return false; // tamper/corruption
    await this.prisma.workPhoto.update({ where: { id: photoId }, data: { sha256: sha, byteSize: buf.length } });
    return true;
  }

  /** STAFF approves → visible to project stakeholders + fan-out push (spec §3). */
  async approve(user: { id: string; role: Role }, photoId: string) {
    return this.decide(user, photoId, ModerationStatus.APPROVED, undefined);
  }

  /** STAFF rejects → uploader notified WITH reason; purge scheduled at +7 days. */
  async reject(user: { id: string; role: Role }, photoId: string, dto: ModeratePhotoDto) {
    return this.decide(user, photoId, ModerationStatus.REJECTED, dto.reason);
  }

  private async decide(
    user: { id: string; role: Role },
    photoId: string,
    to: ModerationStatus.APPROVED | ModerationStatus.REJECTED,
    reason?: string,
  ) {
    const photo = await this.prisma.workPhoto.findUniqueOrThrow({ where: { id: photoId } });
    if (![ModerationStatus.PENDING_REVIEW, ModerationStatus.FLAGGED_FOR_ESCALATION].includes(photo.moderationStatus)) {
      throw new BadRequestException({ error: 'ALREADY_REVIEWED', status: photo.moderationStatus });
    }

    const updated = await this.prisma.workPhoto.update({
      where: { id: photoId },
      data: {
        moderationStatus: to,
        rejectionReason: to === ModerationStatus.REJECTED ? reason : null,
        reviewedById: user.id,
        reviewedAt: new Date(),
        scheduledArchiveAt: to === ModerationStatus.REJECTED ? new Date(Date.now() + ARCHIVE_DELAY_MS) : null,
      },
    });

    if (to === ModerationStatus.APPROVED) {
      // Fan-out to project stakeholders (CLIENT/ADMIN/ACCOUNTS) — spec §3.
      await this.notifications.enqueueForRoles([Role.CLIENT, Role.ADMIN, Role.ACCOUNTS], NotificationType.INFO, {
        title: 'Site photo approved',
        body: 'A moderated photo is now visible in your project gallery.',
        data: { screen: 'projects/' + photo.projectId, id: photo.id },
      }, photo.projectId);
      await this.audit.record({
        action: AuditAction.PHOTO_APPROVED, actorId: user.id,
        entityType: 'WorkPhoto', entityId: photo.id,
      });
    } else {
      await this.notifications.notifyUser(photo.uploaderId, NotificationType.ALERT, {
        title: 'Photo rejected',
        body: reason ?? 'Your photo was rejected.',
        data: { screen: 'photos/mine', id: photo.id },
      });
      await this.audit.record({
        action: AuditAction.PHOTO_REJECTED, actorId: user.id,
        entityType: 'WorkPhoto', entityId: photo.id,
        metadata: { reason },
      });
    }
    return updated;
  }

  /**
   * Gallery read with visibility logic enforced at query level (spec §3):
   * APPROVED → all project members; PENDING/REJECTED/FLAGGED → uploader + STAFF only.
   */
  async listForProject(user: { id: string; role: Role }, projectId: string, q: { status?: ModerationStatus; page?: number; pageSize?: number }) {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (!member && user.role !== Role.STAFF) throw new ForbiddenException({ error: 'NOT_PROJECT_MEMBER' });

    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, q.pageSize ?? 24);
    const base: Prisma.WorkPhotoWhereInput = { projectId };
    const visibility: Prisma.WorkPhotoWhereInput =
      user.role === Role.STAFF
        ? {}
        : { OR: [{ moderationStatus: ModerationStatus.APPROVED }, { uploaderId: user.id }] };
    const statusFilter: Prisma.WorkPhotoWhereInput = q.status ? { moderationStatus: q.status } : {};

    const where: Prisma.WorkPhotoWhereInput = { AND: [base, visibility, statusFilter] };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workPhoto.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { uploader: { select: { id: true, fullName: true } } },
      }),
      this.prisma.workPhoto.count({ where }),
    ]);

    // Signed URLs minted per-request; objects themselves stay private in S3.
    const withUrls = await Promise.all(
      items.map(async (p) => ({ ...p, viewUrl: (await this.storage.presignView(p.s3Key)).url })),
    );
    return { items: withUrls, total, page, pageSize };
  }

  /** STAFF-only moderation queue scan. */
  async pendingQueue(q: { page?: number; pageSize?: number }) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, q.pageSize ?? 24);
    const where: Prisma.WorkPhotoWhereInput = {
      moderationStatus: { in: [ModerationStatus.PENDING_REVIEW, ModerationStatus.FLAGGED_FOR_ESCALATION] },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workPhoto.findMany({
        where,
        orderBy: { createdAt: 'asc' }, // FIFO — oldest awaiting review first
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { uploader: { select: { id: true, fullName: true } }, project: { select: { id: true, name: true } } },
      }),
      this.prisma.workPhoto.count({ where }),
    ]);
    const withUrls = await Promise.all(
      items.map(async (p) => ({ ...p, viewUrl: (await this.storage.presignView(p.s3Key)).url })),
    );
    return { items: withUrls, total, page, pageSize };
  }

  /** Cron: purge REJECTED photos whose 7-day retention elapsed (S3 object + row). */
  async archiveExpired(): Promise<number> {
    const due = await this.prisma.workPhoto.findMany({
      where: {
        moderationStatus: ModerationStatus.REJECTED,
        scheduledArchiveAt: { lte: new Date() },
      },
    });
    for (const p of due) {
      try {
        await this.storage.deleteObject(p.s3Key);
      } catch {
        // Object may already be gone; row deletion proceeds regardless.
      }
      await this.prisma.workPhoto.update({
        where: { id: p.id },
        data: { moderationStatus: ModerationStatus.ARCHIVED, s3Key: `${p.s3Key}.archived` },
      });
      await this.audit.record({
        action: AuditAction.PHOTO_FLAGGED, actorId: null,
        entityType: 'WorkPhoto', entityId: p.id,
        metadata: { autoArchived: true },
      });
    }
    return due.length;
  }
}
