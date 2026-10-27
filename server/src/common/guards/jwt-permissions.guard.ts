import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { hasPermission, PermissionKey } from '../permissions';

/**
 * Two-layer gate on every protected endpoint:
 * 1. Passport JWT strategy (signature + expiry + token type).
 * 2. Permission matrix check — route metadata declares required capabilities.
 * If a route declares no permissions, authentication alone is required.
 */
@Injectable()
export class JwtPermissionsGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<{ user: { id: string; role: Role } }>();

    const denied = required.filter((p) => !hasPermission(request.user.role, p));
    if (denied.length > 0) {
      throw new ForbiddenException({
        error: 'INSUFFICIENT_PERMISSIONS',
        missing: denied,
        role: request.user.role,
      });
    }
    return true;
  }
}
