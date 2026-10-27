import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { JwtPermissionsGuard } from '../common/guards/jwt-permissions.guard';
import { Role } from '@prisma/client';
import { RequestsService } from './requests.service';
import {
  CreateMaterialRequestDto,
  DecideRequestDto,
  IssueStockDto,
  ListRequestsQueryDto,
} from './requests.dto';

/**
 * All routing/approval/deduction logic lives in the service (server-side).
 * Guards enforce the RBAC matrix; `If-Match` carries the optimistic-concurrency
 * version token (suggestion #6) so two approvers cannot clobber each other.
 */
@Controller('api/v1/requests')
@UseGuards(JwtPermissionsGuard, ThrottlerGuard)
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  @RequirePermissions('request:create')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMaterialRequestDto) {
    return this.requests.create({ id: user.id, role: user.role as Role }, dto);
  }

  @Get()
  @RequirePermissions('request:view:project')
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ListRequestsQueryDto) {
    return this.requests.list({ id: user.id, role: user.role as Role }, q);
  }

  @Get(':id')
  @RequirePermissions('request:view:project')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.requests.getDetail(id, { id: user.id, role: user.role as Role });
  }

  @Get(':id/timeline')
  @RequirePermissions('request:view:project')
  timeline(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.requests.timeline(id, { id: user.id, role: user.role as Role });
  }

  /** Delegated (within-limit) approvals — ADMIN only, engine re-checked server-side. */
  @Post(':id/approve-admin')
  @RequirePermissions('request:approve:admin')
  approveAdmin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideRequestDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.requests.approveAsAdmin(
      { id: user.id, role: user.role as Role },
      id,
      dto,
      parseVersion(ifMatch),
    );
  }

  /** High-value / critical approvals — CLIENT (project owner) only. */
  @Post(':id/approve-client')
  @RequirePermissions('request:approve:client')
  approveClient(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideRequestDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.requests.approveAsClient(
      { id: user.id, role: user.role as Role },
      id,
      dto,
      parseVersion(ifMatch),
    );
  }

  @Post(':id/reject')
  @RequirePermissions('request:approve:admin', 'request:approve:client')
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DecideRequestDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.requests.reject({ id: user.id, role: user.role as Role }, id, dto, parseVersion(ifMatch));
  }

  @Post(':id/cancel')
  @RequirePermissions('request:cancel:own')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Headers('if-match') ifMatch?: string) {
    return this.requests.cancel({ id: user.id }, id, parseVersion(ifMatch));
  }

  /** Atomic stock deduction + immutable ledger write — ADMIN only. */
  @Post(':id/issue')
  @RequirePermissions('request:issue')
  issue(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: IssueStockDto) {
    return this.requests.issueStock({ id: user.id, role: user.role as Role }, id, dto);
  }
}

/** If-Match: "5" | 5 → number; absent header → undefined (no concurrency check). */
function parseVersion(ifMatch?: string): number | undefined {
  if (!ifMatch) return undefined;
  const n = parseInt(ifMatch.replace(/"/g, ''), 10);
  if (Number.isNaN(n)) throw new ConflictException({ error: 'INVALID_IF_MATCH' });
  return n;
}
