import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalDecision,
  AuditAction,
  MaterialCriticality,
  NotificationType,
  Prisma,
  RequestStatus,
  Role,
  StockMovementType,
} from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationService } from '../notifications/notification.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalEngineService } from './approval-engine.service';
import { ConcurrencyConflictError } from './concurrency.exception';
import { CreateMaterialRequestDto, DecideRequestDto, IssueStockDto, ListRequestsQueryDto } from './requests.dto';

/** Every status a request in `from` may legally transition to. Enforced server-side only. */
const STATUS_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  DRAFT: [RequestStatus.CANCELLED],
  PENDING_ADMIN_APPROVAL: [RequestStatus.APPROVED, RequestStatus.REJECTED, RequestStatus.CANCELLED],
  PENDING_CLIENT_APPROVAL: [RequestStatus.APPROVED, RequestStatus.REJECTED, RequestStatus.CANCELLED],
  APPROVED: [RequestStatus.PARTIALLY_ISSUED, RequestStatus.FULLY_ISSUED],
  PARTIALLY_ISSUED: [RequestStatus.PARTIALLY_ISSUED, RequestStatus.FULLY_ISSUED],
  REJECTED: [],
  FULLY_ISSUED: [],
  CANCELLED: [],
};

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ApprovalEngineService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── Create (POST /api/v1/requests) ─────────────────────────────

  /**
   * Spec §4 — all routing inputs are recomputed from DB truth:
   *  - prices come from the Material catalog, never from the client;
   *  - delegated limit + used amount come from the Project row;
   *  - criticality comes from the joined Material rows.
   * Idempotency: a replayed offline-queue submission returns the original row.
   */
  async create(user: { id: string; role: Role }, dto: CreateMaterialRequestDto) {
    const existing = await this.prisma.materialRequest.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existing) {
      // Replay of an offline retry → return the original response, no duplicate.
      return this.getDetail(existing.id, user);
    }

    const project = await this.prisma.project.findFirst({
      where: { id: dto.projectId, isActive: true },
      include: { members: { select: { userId: true } } },
    });
    if (!project) throw new NotFoundException({ error: 'PROJECT_NOT_FOUND' });
    // Membership gate: requesters must belong to the project (worker or staff acting for it).
    if (!project.members.some((m) => m.userId === user.id)) {
      throw new ForbiddenException({ error: 'NOT_PROJECT_MEMBER' });
    }

    // De-duplicate lines per material (sum quantities) then price server-side.
    const qtyByMaterial = new Map<string, number>();
    for (const line of dto.lines) {
      qtyByMaterial.set(line.materialId, (qtyByMaterial.get(line.materialId) ?? 0) + line.quantity);
    }
    const materials = await this.prisma.material.findMany({
      where: { id: { in: [...qtyByMaterial.keys()] } },
    });
    if (materials.length !== qtyByMaterial.size) {
      throw new BadRequestException({ error: 'UNKNOWN_MATERIAL', missing: true });
    }

    const pricedLines = materials.map((m) => {
      const quantity = qtyByMaterial.get(m.id)!;
      const unitPrice = m.unitPrice;
      const lineTotal = unitPrice.mul(quantity);
      return { materialId: m.id, quantity, unitPrice, lineTotal, criticality: m.criticality };
    });
    const estimatedCost = pricedLines.reduce((s, l) => s.add(l.lineTotal), new Prisma.Decimal(0));
    const maxCriticality = pricedLines.reduce<MaterialCriticality>(
      (acc, l) => rank(l.criticality) > rank(acc) ? l.criticality : acc,
      MaterialCriticality.LOW,
    );

    const decision = this.engine.route({
      estimatedCost: estimatedCost.toNumber(),
      adminDelegatedLimit: project.adminDelegatedLimit.toNumber(),
      delegatedUsedAmount: project.delegatedUsedAmount.toNumber(),
      maxCriticality,
      requesterRole: user.role,
    });

    const reference = await this.generateReference();

    const request = await this.prisma.materialRequest.create({
      data: {
        reference,
        projectId: project.id,
        requesterId: user.id,
        status: decision.routedTo,
        routedTo: decision.routedTo,
        routingReason: decision.reason,
        needsHighValue: decision.needsHighValue,
        estimatedCost,
        justification: dto.justification,
        needByDate: new Date(dto.needByDate),
        idempotencyKey: dto.idempotencyKey,
        lines: {
          create: pricedLines.map((l) => ({
            materialId: l.materialId,
            quantity: l.quantity,
            unitPriceSnapshot: l.unitPrice,
            lineTotal: l.lineTotal,
          })),
        },
      },
      include: { lines: { include: { material: true } } },
    });

    await this.audit.record({
      action: AuditAction.REQUEST_CREATED,
      actorId: user.id,
      entityType: 'MaterialRequest',
      entityId: request.id,
      metadata: { reference, cost: estimatedCost.toString(), route: decision.routedTo, reason: decision.reason },
    });
    await this.audit.record({
      action: AuditAction.REQUEST_ROUTED,
      actorId: null, // engine-driven, not human
      entityType: 'MaterialRequest',
      entityId: request.id,
      metadata: { routedTo: decision.routedTo, reason: decision.reason },
    });

    // Fan-out plan per spec §4 — enqueued transactionally by the dispatcher later.
    const plans = this.engine.planNotifications(decision, reference, request.id);
    for (const p of plans) {
      await this.notifications.enqueueForRoles(p.roles, p.type, { title: p.title, body: p.body, data: p.data }, project.id);
    }

    return request;
  }

  // ───────────────────────────── Approval (server-authoritative) ─────────────────────────────

  /**
   * ADMIN path: within-limit approvals debit Project.delegatedUsedAmount inside a
   * SERIALIZABLE transaction so two concurrent admins cannot over-spend the cap.
   * The engine is RE-checked at decision time with fresh values — a request that
   * was routed to Admin but whose limit got consumed meanwhile is bounced to the
   * Client queue instead of being silently approved (conflict-safe routing).
   */
  async approveAsAdmin(user: { id: string; role: Role }, requestId: string, dto: DecideRequestDto, expectedVersion?: number) {
    return this.prisma.serializable(async (tx) => {
      const request = await tx.materialRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { project: true, lines: { include: { material: true } } },
      });

      this.assertTransition(request.status, RequestStatus.APPROVED);
      if (request.status !== RequestStatus.PENDING_ADMIN_APPROVAL) {
        throw new ConflictException({ error: 'NOT_IN_ADMIN_QUEUE', status: request.status });
      }
      this.assertVersion(request.version, expectedVersion);

      // Re-run the engine against FRESH limit state (spec: no stale routing).
      const remaining = request.project.adminDelegatedLimit.sub(request.project.delegatedUsedAmount);
      if (request.estimatedCost.gt(remaining)) {
        // Limit exhausted while queued → re-route to client rather than approve.
        const rerouted = await tx.materialRequest.update({
          where: { id: request.id },
          data: {
            status: RequestStatus.PENDING_CLIENT_APPROVAL,
            needsHighValue: true,
            routingReason: `re-checked at approval time: cost ${request.estimatedCost} > remaining limit ${remaining}`,
            version: { increment: 1 },
          },
        });
        await this.notifications.enqueueForRoles([Role.CLIENT], NotificationType.ACTION_REQUIRED, {
          title: `Approval needed · ${request.reference}`,
          body: 'Delegated budget was exhausted — request escalated to you.',
          data: { screen: 'requests/[id]', id: request.id },
        }, request.projectId);
        await this.audit.record({
          action: AuditAction.REQUEST_ROUTED, actorId: user.id,
          entityType: 'MaterialRequest', entityId: request.id,
          metadata: { reroutedTo: 'PENDING_CLIENT_APPROVAL', remaining: remaining.toString() },
        });
        return rerouted;
      }

      const now = new Date();
      const updated = await tx.materialRequest.update({
        where: { id: request.id, version: expectedVersion ?? request.version },
        data: {
          status: RequestStatus.APPROVED,
          approvedAt: now,
          version: { increment: 1 },
          approvals: {
            create: {
              approverId: user.id,
              decision: ApprovalDecision.APPROVED,
              comment: dto.comment,
              amountCommitted: request.estimatedCost,
            },
          },
        },
      });

      // Atomic debit of the delegated budget — same serializable transaction.
      await tx.project.update({
        where: { id: request.projectId },
        data: { delegatedUsedAmount: { increment: request.estimatedCost } },
      });

      await this.notifications.enqueueForRoles([Role.WORKER], NotificationType.INFO, {
        title: `Approved · ${request.reference}`,
        body: 'Materials can now be issued at the store.',
        data: { screen: 'requests/[id]', id: request.id },
      }, request.projectId);
      await this.notifications.enqueueForRoles([Role.ACCOUNTS], NotificationType.FINANCIAL_COMMITMENT, {
        title: `Commitment booked · ${request.reference}`,
        body: `Admin-approved spend ${request.estimatedCost} recorded.`,
        data: { screen: 'requests/[id]', id: request.id },
      }, request.projectId);

      await this.audit.record({
        action: AuditAction.REQUEST_APPROVED, actorId: user.id,
        entityType: 'MaterialRequest', entityId: request.id,
        metadata: { amount: request.estimatedCost.toString(), via: 'ADMIN_DELEGATED' },
      });
      return updated;
    });
  }

  /** CLIENT path: owner approves high-value/critical requests. No delegated debit. */
  async approveAsClient(user: { id: string; role: Role }, requestId: string, dto: DecideRequestDto, expectedVersion?: number) {
    return this.prisma.serializable(async (tx) => {
      const request = await tx.materialRequest.findUniqueOrThrow({ where: { id: requestId } });
      this.assertTransition(request.status, RequestStatus.APPROVED);
      if (request.status !== RequestStatus.PENDING_CLIENT_APPROVAL) {
        throw new ConflictException({ error: 'NOT_IN_CLIENT_QUEUE', status: request.status });
      }
      this.assertVersion(request.version, expectedVersion);

      const updated = await tx.materialRequest.update({
        where: { id: request.id },
        data: {
          status: RequestStatus.APPROVED,
          approvedAt: new Date(),
          version: { increment: 1 },
          approvals: {
            create: { approverId: user.id, decision: ApprovalDecision.APPROVED, comment: dto.comment, amountCommitted: 0 },
          },
        },
      });

      await this.notifications.enqueueForRoles([Role.WORKER], NotificationType.INFO, {
        title: `Approved · ${request.reference}`,
        body: 'The project owner approved your request.',
        data: { screen: 'requests/[id]', id: request.id },
      }, request.projectId);
      await this.notifications.enqueueForRoles([Role.ADMIN], NotificationType.ACTION_REQUIRED, {
        title: `Ready to issue · ${request.reference}`,
        body: 'Owner-approved materials awaiting stock issue.',
        data: { screen: 'requests/[id]', id: request.id },
      }, request.projectId);

      await this.audit.record({
        action: AuditAction.REQUEST_APPROVED, actorId: user.id,
        entityType: 'MaterialRequest', entityId: request.id,
        metadata: { via: 'CLIENT_OWNER' },
      });
      return updated;
    });
  }

  /** Both queues share reject semantics; a comment (reason) is mandatory. */
  async reject(user: { id: string; role: Role }, requestId: string, dto: DecideRequestDto, expectedVersion?: number) {
    if (!dto.comment || dto.comment.trim().length < 5) {
      throw new BadRequestException({ error: 'REJECTION_COMMENT_REQUIRED' });
    }
    const request = await this.prisma.materialRequest.findUniqueOrThrow({ where: { id: requestId } });
    const queue = request.status;
    this.assertTransition(queue, RequestStatus.REJECTED);

    const updated = await this.prisma.materialRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.REJECTED,
        rejectedAt: new Date(),
        version: { increment: 1 },
        approvals: {
          create: { approverId: user.id, decision: ApprovalDecision.REJECTED, comment: dto.comment },
        },
      },
    });

    await this.notifications.notifyUser(request.requesterId, NotificationType.INFO, {
      title: `Rejected · ${request.reference}`,
      body: dto.comment!,
      data: { screen: 'requests/[id]', id: requestId },
    });
    await this.audit.record({
      action: AuditAction.REQUEST_REJECTED, actorId: user.id,
      entityType: 'MaterialRequest', entityId: requestId,
      metadata: { fromQueue: queue, comment: dto.comment },
    });
    return updated;
  }

  /** Worker cancels own pending request. Ownership checked server-side. */
  async cancel(user: { id: string }, requestId: string, expectedVersion?: number) {
    const request = await this.prisma.materialRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.requesterId !== user.id) throw new ForbiddenException({ error: 'NOT_OWNER' });
    this.assertTransition(request.status, RequestStatus.CANCELLED);

    return this.prisma.materialRequest.update({
      where: { id: requestId },
      data: { status: RequestStatus.CANCELLED, cancelledAt: new Date(), version: { increment: 1 } },
    });
  }

  // ───────────────────────────── Stock issue (atomic deduction) ─────────────────────────────

  /**
   * Server-side inventory deduction — ledger-only writes (immutable StockMovement
   * rows with balanceAfter snapshots). Guarded by SERIALIZABLE isolation so
   * concurrent issues can never oversell below zero.
   */
  async issueStock(user: { id: string; role: Role }, requestId: string, dto: IssueStockDto) {
    return this.prisma.serializable(async (tx) => {
      const request = await tx.materialRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { lines: true },
      });
      if (![RequestStatus.APPROVED, RequestStatus.PARTIALLY_ISSUED].includes(request.status)) {
        throw new ConflictException({ error: 'NOT_APPROVED_FOR_ISSUE', status: request.status });
      }

      for (const item of dto.lines) {
        const line = request.lines.find((l) => l.id === item.lineId);
        if (!line) throw new NotFoundException({ error: 'LINE_NOT_FOUND', lineId: item.lineId });
        const outstanding = line.quantity - line.issuedQuantity;
        if (item.quantity > outstanding) {
          throw new ConflictException({
            error: 'STOCK_CONFLICT_FETCH_LATEST', // mobile offline-queue surfaces this to refetch
            lineId: line.id,
            outstanding,
            requested: item.quantity,
          });
        }
        const material = await tx.material.findUniqueOrThrow({ where: { id: line.materialId } });
        if (material.currentStock < item.quantity) {
          throw new ConflictException({
            error: 'INSUFFICIENT_STOCK',
            sku: material.sku,
            available: material.currentStock,
            requested: item.quantity,
          });
        }

        const newStock = material.currentStock - item.quantity;
        await tx.material.update({
          where: { id: material.id },
          data: { currentStock: newStock },
        });
        await tx.stockMovement.create({
          data: {
            materialId: material.id,
            projectId: request.projectId,
            type: StockMovementType.ISSUE_OUT,
            quantity: -item.quantity, // signed ledger
            unitCost: line.unitPriceSnapshot,
            balanceAfter: newStock,
            requestId: request.id,
            issuedById: user.id,
            note: dto.note,
          },
        });
        await tx.materialRequestLine.update({
          where: { id: line.id },
          data: { issuedQuantity: { increment: item.quantity } },
        });
      }

      const refreshed = await tx.materialRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { lines: true },
      });
      const fullyIssued = refreshed.lines.every((l) => l.issuedQuantity >= l.quantity);
      const nextStatus = fullyIssued ? RequestStatus.FULLY_ISSUED : RequestStatus.PARTIALLY_ISSUED;

      const updated = await tx.materialRequest.update({
        where: { id: requestId },
        data: { status: nextStatus, version: { increment: 1 } },
        include: { lines: { include: { material: true } } },
      });

      await this.notifications.notifyUser(request.requesterId, NotificationType.INFO, {
        title: `${fullyIssued ? 'Fully issued' : 'Partially issued'} · ${request.reference}`,
        body: 'Materials were collected from the store.',
        data: { screen: 'requests/[id]', id: requestId },
      });
      await this.audit.record({
        action: AuditAction.STOCK_ISSUED, actorId: user.id,
        entityType: 'MaterialRequest', entityId: requestId,
        metadata: { lines: dto.lines, status: nextStatus },
      });
      return updated;
    });
  }

  // ───────────────────────────── Reads (RBAC-scoped visibility) ─────────────────────────────

  async list(user: { id: string; role: Role }, q: ListRequestsQueryDto) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where: Prisma.MaterialRequestWhereInput = {};

    if (q.status) where.status = q.status as RequestStatus;
    if (q.projectId) where.projectId = q.projectId;

    // Visibility rules enforced here, not on the client:
    if (user.role === Role.WORKER) {
      where.requesterId = user.id; // workers see their own requests only
    } else if (user.role === Role.CLIENT || user.role === Role.ADMIN || user.role === Role.ACCOUNTS) {
      where.project = { members: { some: { userId: user.id } } };
    } // STAFF sees everything (ops coordinator)

    const [items, total] = await this.prisma.$transaction([
      this.prisma.materialRequest.findMany({
        where,
        include: { lines: { include: { material: true } }, project: true, requester: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.materialRequest.count({ where }),
    ]);
    return { items, total, page, pageSize, versionField: 'version' };
  }

  async getDetail(requestId: string, user: { id: string; role: Role }) {
    const request = await this.prisma.materialRequest.findUnique({
      where: { id: requestId },
      include: {
        lines: { include: { material: true } },
        project: true,
        requester: { select: { id: true, fullName: true, role: true } },
        approvals: { include: { approver: { select: { id: true, fullName: true, role: true } } }, orderBy: { createdAt: 'asc' } },
        movements: { orderBy: { createdAt: 'desc' }, include: { issuedBy: { select: { id: true, fullName: true } } } },
        photos: {
          // Photo visibility logic (spec §3) applied at query level:
          where: this.photoVisibilityFilter(user),
        },
      },
    });
    if (!request) throw new NotFoundException({ error: 'REQUEST_NOT_FOUND' });
    if (user.role === Role.WORKER && request.requesterId !== user.id) {
      throw new ForbiddenException({ error: 'NOT_OWNER' });
    }
    if ((user.role === Role.CLIENT || user.role === Role.ADMIN || user.role === Role.ACCOUNTS) &&
      !(await this.isProjectMember(request.projectId, user.id))) {
      throw new ForbiddenException({ error: 'NOT_PROJECT_MEMBER' });
    }
    return request;
  }

  /** Timeline projection for the mobile TimelineItem component (server-ordered). */
  async timeline(requestId: string, user: { id: string; role: Role }) {
    const request = await this.prisma.materialRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { approvals: { include: { approver: true } }, movements: { include: { issuedBy: true } } },
    });
    const logs = await this.prisma.auditLog.findMany({
      where: { entityType: 'MaterialRequest', entityId: requestId },
      orderBy: { createdAt: 'asc' },
    });
    return { requestId, version: request.version, events: logs };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private photoVisibilityFilter(user: { id: string; role: Role }): Prisma.WorkPhotoWhereInput {
    if (user.role === Role.STAFF) return {}; // gatekeeper sees all states
    return {
      OR: [
        { moderationStatus: 'APPROVED' },
        { uploaderId: user.id }, // own uploads visible pre-approval
      ],
    };
  }

  private async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    const m = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    return !!m;
  }

  private assertTransition(from: RequestStatus, to: RequestStatus): void {
    if (!STATUS_TRANSITIONS[from].includes(to)) {
      throw new ConflictException({ error: 'INVALID_STATUS_TRANSITION', from, to });
    }
  }

  private assertVersion(current: number, expected?: number): void {
    if (expected !== undefined && expected !== current) {
      throw new ConcurrencyConflictError('MaterialRequest', current);
    }
  }

  private async generateReference(): Promise<string> {
    const d = new Date();
    const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = `REQ-${ymd}-${String(randomInt(0, 10000)).padStart(4, '0')}`;
      const clash = await this.prisma.materialRequest.findUnique({ where: { reference: ref } });
      if (!clash) return ref;
    }
    return `REQ-${ymd}-${Date.now().toString(36).toUpperCase()}`;
  }
}

function rank(c: MaterialCriticality): number {
  return c === MaterialCriticality.HIGH ? 3 : c === MaterialCriticality.MEDIUM ? 2 : 1;
}
