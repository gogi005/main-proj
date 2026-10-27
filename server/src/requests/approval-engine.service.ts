import { Injectable, Logger } from '@nestjs/common';
import {
  MaterialCriticality,
  NotificationType,
  RequestStatus,
  Role,
} from '@prisma/client';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SMART APPROVAL ENGINE — server-side only. The mobile client NEVER routes.
 *
 * Decision tree (per spec §4):
 *   1. Estimated cost is recomputed from DB catalog prices (client prices ignored).
 *   2. remainingLimit = Project.adminDelegatedLimit − delegatedUsedAmount
 *   3. maxCriticality = highest MaterialCriticality among requested lines
 *   4. IF cost <= remainingLimit AND maxCriticality != HIGH → ADMIN queue
 *      ELSE → CLIENT queue
 *   5. Routing writes an explainable `routingReason` trace for the audit timeline.
 *
 * Concurrency: two admins approving near-simultaneously could both pass the
 * limit check under READ COMMITTED; therefore approval commits run inside a
 * SERIALIZABLE transaction (see RequestsService.approve) and this engine is
 * re-checked at decision time with fresh limit values.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface RoutingInput {
  estimatedCost: number; // recomputed server-side before calling
  adminDelegatedLimit: number;
  delegatedUsedAmount: number;
  maxCriticality: MaterialCriticality;
  requesterRole: Role;
}

export interface RoutingDecision {
  routedTo: RequestStatus.PENDING_ADMIN_APPROVAL | RequestStatus.PENDING_CLIENT_APPROVAL;
  reason: string;
  needsHighValue: boolean;
}

@Injectable()
export class ApprovalEngineService {
  private readonly logger = new Logger(ApprovalEngineService.name);

  route(input: RoutingInput): RoutingDecision {
    const remaining = input.adminDelegatedLimit - input.delegatedUsedAmount;
    const withinLimit = input.estimatedCost <= remaining;
    const critical = input.maxCriticality === MaterialCriticality.HIGH;

    if (withinLimit && !critical) {
      return {
        routedTo: RequestStatus.PENDING_ADMIN_APPROVAL,
        needsHighValue: false,
        reason:
          `cost ${input.estimatedCost.toFixed(2)} <= remaining delegated limit ` +
          `${remaining.toFixed(2)} (limit ${input.adminDelegatedLimit.toFixed(2)}, ` +
          `used ${input.delegatedUsedAmount.toFixed(2)}) and criticality=${input.maxCriticality}`,
      };
    }

    const drivers: string[] = [];
    if (!withinLimit) {
      drivers.push(`cost ${input.estimatedCost.toFixed(2)} > remaining limit ${remaining.toFixed(2)}`);
    }
    if (critical) {
      drivers.push('contains HIGH-criticality material');
    }
    return {
      routedTo: RequestStatus.PENDING_CLIENT_APPROVAL,
      needsHighValue: !withinLimit,
      reason: drivers.join(' AND '),
    };
  }

  /**
   * Fan-out plan per spec §4:
   *  ADMIN queue  → Admin(ACTION), Client(INFO), Accounts(FINANCIAL_COMMITMENT)
   *  CLIENT queue → Client(ACTION), Admin(ALERT), Accounts(HIGH_VALUE_ALERT)
   * Each entry carries a deep-link `data` payload for Expo Router.
   */
  planNotifications(
    decision: RoutingDecision,
    reference: string,
    requestId: string,
  ): Array<{ roles: Role[]; type: NotificationType; title: string; body: string; data: Record<string, string> }> {
    const data = { screen: 'requests/[id]', id: requestId };
    const entries: Array<{ roles: Role[]; type: NotificationType; title: string; body: string }> =
      decision.routedTo === RequestStatus.PENDING_ADMIN_APPROVAL
        ? [
            {
              roles: [Role.ADMIN],
              type: NotificationType.ACTION_REQUIRED,
              title: `Approval needed · ${reference}`,
              body: 'A material request is waiting in your delegated queue.',
            },
            {
              roles: [Role.CLIENT],
              type: NotificationType.INFO,
              title: `Request routed to store manager · ${reference}`,
              body: 'Within your delegated limit — no action required.',
            },
            {
              roles: [Role.ACCOUNTS],
              type: NotificationType.FINANCIAL_COMMITMENT,
              title: `Commitment pending · ${reference}`,
              body: 'A spend commitment awaits admin approval.',
            },
          ]
        : [
            {
              roles: [Role.CLIENT],
              type: NotificationType.ACTION_REQUIRED,
              title: `Your approval needed · ${reference}`,
              body: decision.reason,
            },
            {
              roles: [Role.ADMIN],
              type: NotificationType.ALERT,
              title: `Escalated to owner · ${reference}`,
              body: 'Request exceeded delegation or contains critical materials.',
            },
            {
              roles: [Role.ACCOUNTS],
              type: NotificationType.HIGH_VALUE_ALERT,
              title: `High-value request · ${reference}`,
              body: 'Awaiting owner approval — budget exposure flagged.',
            },
          ];

    return entries.map((e) => ({ ...e, data }));
  }
}

