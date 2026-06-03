import { Controller, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../../../auth/decorators/public.decorator';
import { CustomLoggerService } from '../../../common/services/custom-logger.service';
import { WebhookIntakeService } from '../services/webhook-intake.service';

type RawRequest = Request & { rawBody?: Buffer };

const LOG_CONTEXT = 'WebhooksController';

/**
 * Catch-all webhook receiver (story 3.1 / EVO-1207). Dumb pipe: accepts a
 * provider payload (Evolution API, SendGrid, MailerSend, ...) and hands it to
 * the intake seam. It does NOT validate signatures (story 3.4) or publish to
 * the broker (story 3.2).
 *
 * Uses @Res() to control the exact wire response — external providers key off
 * the status code, and the bare `{ ok: true }` / `{ error: ... }` bodies must
 * not be wrapped by the global ResponseTransformInterceptor.
 */
@Controller('webhooks')
@Public()
export class WebhooksController {
  constructor(
    private readonly logger: CustomLoggerService,
    private readonly intake: WebhookIntakeService,
  ) {}

  @Post('*splat')
  async receive(@Req() req: RawRequest, @Res() res: Response): Promise<void> {
    const platform = this.extractPlatform(req);
    const contentType = String(req.headers['content-type'] ?? '');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : req.rawBody;

    let parsed: unknown;
    try {
      parsed = this.parsePayload(rawBody, contentType);
    } catch {
      this.logger.warn(
        `Rejected malformed webhook payload (platform=${platform}, content-type=${contentType})`,
        LOG_CONTEXT,
      );
      res.status(400).json({ error: 'malformed_payload' });
      return;
    }

    this.logger.log(
      `Webhook received (platform=${platform}, bytes=${rawBody?.length ?? 0})`,
      LOG_CONTEXT,
    );

    try {
      await this.intake.intake({ platform, contentType, rawBody, parsed });
    } catch (error) {
      this.logger.error(
        `Webhook intake failed (platform=${platform}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        LOG_CONTEXT,
      );
      // Provider may redeliver — Retry-After advertises a backoff (story 3.2
      // is what actually makes intake() capable of throwing on publish failure).
      res.setHeader('Retry-After', '10');
      res.status(503).json({ error: 'service_unavailable' });
      return;
    }

    res.status(200).json({ ok: true });
  }

  private extractPlatform(req: RawRequest): string {
    // Express 5 / path-to-regexp v8 exposes the `*splat` wildcard capture as an
    // array of path segments.
    const splat = (req.params as Record<string, string | string[]>)?.['splat'];
    if (Array.isArray(splat)) return splat.join('/');
    if (typeof splat === 'string' && splat.length > 0) return splat;
    return req.path.replace(/^\/+webhooks\/?/, '') || 'unknown';
  }

  private parsePayload(
    rawBody: Buffer | undefined,
    contentType: string,
  ): unknown {
    if (!rawBody || rawBody.length === 0) return null;
    const text = rawBody.toString('utf8');
    if (contentType.includes('application/json')) {
      return JSON.parse(text);
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    // text/plain and anything else: a dumb pipe accepts the raw text as-is.
    return text;
  }
}
