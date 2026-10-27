import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Optimistic-concurrency failure (suggestion #6). Surfaces as HTTP 409 with the
 * CURRENT server version so the mobile offline queue can refetch latest state
 * and rebase before retrying — never blind-overwrite.
 */
export class ConcurrencyConflictError extends HttpException {
  constructor(entity: string, currentVersion: number, detail?: Record<string, unknown>) {
    super(
      {
        error: 'CONCURRENCY_CONFLICT',
        entity,
        currentVersion,
        ...detail,
      },
      HttpStatus.CONFLICT,
    );
  }
}
