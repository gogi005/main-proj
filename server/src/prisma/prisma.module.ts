import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient for the whole app (connection pooling handled by
 * PgBouncer / Prisma's internal pool). Use `serializable()` for the flows that
 * must not lose updates (approval + delegated-limit debit, stock issue).
 */
export const PRISMA = 'PRISMA_CLIENT';

@Injectable()
export class PrismaService extends PrismaClient {
  constructor() {
    super({ log: ['warn', 'error'] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Serializable isolation — prevents two admins concurrently over-spending a delegated limit. */
  async serializable<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.$transaction(fn, {
      isolationLevel: 'Serializable',
      maxWait: 5_000,
      timeout: 30_000,
    });
  }
}

@Global()
@Module({
  providers: [PrismaService, { provide: PRISMA, useExisting: PrismaService }],
  exports: [PrismaService, PRISMA],
})
export class PrismaModule {}
