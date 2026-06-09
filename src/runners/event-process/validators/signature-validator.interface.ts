import { Platform } from 'src/shared/broker/contracts/platform.enum';

/**
 * One signature validator per webhook provider (story 3.4 / EVO-1210). Each
 * provider signs its payload differently — HMAC variants, HTTP Basic Auth,
 * Svix, AWS SNS, static token — so the registry resolves the right one by
 * `platform` and the event-process pipeline calls `validate` before doing any
 * further work.
 *
 * `validate` may be async: the SES (SNS) validator fetches and caches the
 * signing certificate over HTTPS, which cannot be done synchronously. The
 * HMAC/Basic/token validators stay synchronous and just return a boolean.
 */
export interface ISignatureValidator {
  readonly platform: Platform;
  validate(
    rawPayload: string,
    headers: Record<string, string>,
  ): boolean | Promise<boolean>;
}
