import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from '../permissions';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Usage: @RequirePermissions('request:approve:admin')
 * Enforced by JwtAuthGuard + PermissionsGuard on every protected endpoint.
 */
export const RequirePermissions = (...perms: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);
