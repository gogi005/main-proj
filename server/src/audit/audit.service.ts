import { Global, Injectable, Module } from '@nestjs/common';
import { AuditAction, PrismaClient } from '@prisma/client';
import { Request as ExpressRequest } from 'express';

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  /** Raw request — IP + user-agent captured server-side, never trusted from client. */
  request?: ExpressRequest;
}

/**
 * Structured audit trail. Every guarded mutation calls this explicitly at the
 * service layer so the trail cannot be bypassed by adding new controllers.
 * Failure to write an audit row is logged but never breaks the business flow.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry): Promise<void> {
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    if (entry.request) {
      metadata.ip =
        (entry.request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
        entry.request.ip;
      metadata.userAgent = entry.request.headers['user-agent'];
    }
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId ?? null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          metadata: metadata as never,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[audit] failed to persist audit entry', err);
    }
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
