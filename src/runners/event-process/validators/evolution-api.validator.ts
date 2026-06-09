import { ISignatureValidator } from './signature-validator.interface';
import { getHeader, safeEqual } from './signature-validator.util';

/**
 * Evolution API: static shared token. Evolution does not HMAC-sign webhook
 * deliveries; it forwards a configured token in the `apikey` header (its own
 * auth convention — see evolution-api `auth.guard.ts`). We also accept an
 * `Authorization: Bearer <token>` fallback, compared constant-time.
 */
export class EvolutionApiValidator implements ISignatureValidator {
  readonly platform = 'evolution-api';

  constructor(private readonly token?: string) {}

  validate(_rawPayload: string, headers: Record<string, string>): boolean {
    if (!this.token) return false;
    const provided =
      getHeader(headers, 'apikey') ??
      getHeader(headers, 'Authorization')?.replace(/^Bearer\s+/i, '');
    if (!provided) return false;
    return safeEqual(this.token, provided);
  }
}
