import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyMetrics } from './idempotency.metrics';

/**
 * Global module exposing the shared exactly-once guard (story 2.4 / EVO-1204).
 * Consumed by the webhook event pipeline (story 3.5) and any other call site
 * that needs SHA256 + atomic Redis dedup.
 */
@Global()
@Module({
  providers: [IdempotencyMetrics, IdempotencyService],
  exports: [IdempotencyService, IdempotencyMetrics],
})
export class IdempotencyModule {}
