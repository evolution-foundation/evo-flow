import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ClsService } from 'nestjs-cls';
import { v7 as uuidv7 } from 'uuid';

/**
 * Populates CLS context with request-scoped metadata: transactionId, ip, userAgent.
 * Single-account mode: no accountId/authType in CLS (evo-flow-cleanup).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    this.cls.set('transactionId', uuidv7());
    this.cls.set('ip', req.ip);
    this.cls.set('userAgent', req.header('user-agent'));
    next();
  }
}
