import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { EvoExtensionPoints, RuntimeContext } from '../registry';
import { RUNTIME_CONTEXT_REQUEST_KEY } from './runtime-context.types';

interface RequestWithUser extends Request {
  user?: { id?: string } & Record<string, unknown>;
}

@Injectable()
export class RuntimeContextMiddleware implements NestMiddleware {
  async use(
    req: RequestWithUser,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const defaultContext: RuntimeContext = {
      request_id: this.resolveRequestId(req),
      user_id: req.user?.id ?? null,
      scope_id: null,
      feature_flags: {},
    };

    const enricher = EvoExtensionPoints.get('runtime_context');
    const finalContext = await enricher(req, defaultContext);

    Object.assign(req, { [RUNTIME_CONTEXT_REQUEST_KEY]: finalContext });
    next();
  }

  private resolveRequestId(req: Request): string {
    const headerId = req.header('x-request-id');
    return headerId && headerId.length > 0 ? headerId : uuidv7();
  }
}
