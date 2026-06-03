import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';
import { CorrelationContext } from '../shared/correlation/correlation.context';
import { CORRELATION_HEADER } from '../shared/correlation/correlation.constants';

/**
 * Populates CLS context with request-scoped metadata: transactionId, ip,
 * userAgent, and correlationId. Single-account mode: no accountId/authType in
 * CLS (evo-flow-cleanup).
 *
 * `correlationId` preserves an inbound `X-Correlation-Id` (cross-service
 * chaining) or generates one — distinct from the always-fresh `transactionId`.
 * Set here (rather than in an interceptor) so it is available before any
 * downstream log, mirroring how `transactionId` is populated.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly cls: ClsService,
    private readonly correlation: CorrelationContext,
  ) {}

  use(req: Request, _res: Response, next: NextFunction) {
    this.cls.set('transactionId', uuidv7());
    this.cls.set('ip', req.ip);
    this.cls.set('userAgent', req.header('user-agent'));
    this.correlation.setCorrelationId(
      this.correlation.resolveIncoming(req.header(CORRELATION_HEADER)),
    );
    next();
  }
}
