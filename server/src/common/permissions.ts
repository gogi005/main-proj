import { Role } from '@prisma/client';

/**
 * Server-side RBAC permission matrix.
 * Single source of truth — guards, approval engine and notification fan-out all
 * resolve capabilities through this map, never through ad-hoc role string checks.
 */
export const PERMISSIONS = {
  'request:create': [Role.WORKER, Role.STAFF],
  'request:view:own': [Role.WORKER],
  'request:view:project': [Role.WORKER, Role.CLIENT, Role.ADMIN, Role.STAFF, Role.ACCOUNTS],
  'request:approve:admin': [Role.ADMIN], // delegated queue only (limit enforced in engine)
  'request:approve:client': [Role.CLIENT], // high-value / critical queue
  'request:issue': [Role.ADMIN], // atomic stock deduction happens here server-side
  'request:cancel:own': [Role.WORKER],

  'inventory:view': [Role.ADMIN, Role.STAFF, Role.ACCOUNTS, Role.CLIENT],
  'inventory:manage': [Role.ADMIN], // ADMIN only — ACCOUNTS can NEVER modify stock
  'inventory:verify': [Role.ADMIN, Role.STAFF],

  'photo:upload': [Role.WORKER, Role.CLIENT],
  'photo:moderate': [Role.STAFF], // the moderation gatekeeper role
  'photo:view:approved': [Role.WORKER, Role.CLIENT, Role.ADMIN, Role.STAFF, Role.ACCOUNTS],

  'user:manage': [Role.STAFF],
  'project:assign': [Role.STAFF],
  'audit:view': [Role.STAFF],

  'finance:invoices:view': [Role.ACCOUNTS, Role.CLIENT],
  'finance:reports:generate': [Role.ACCOUNTS],
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export function hasPermission(role: Role, permission: PermissionKey): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
