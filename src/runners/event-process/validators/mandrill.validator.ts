import { createHmac } from 'crypto';
import { ISignatureValidator } from './signature-validator.interface';
import { getHeader, safeEqual } from './signature-validator.util';

/**
 * Mandrill: HMAC-SHA1 (base64), header `X-Mandrill-Signature`. The signed data
 * is the configured webhook URL followed by each POST param's key + value in
 * ascending key order, so we re-parse the form-encoded raw body and need the
 * exact URL Mandrill is configured to deliver to.
 */
export class MandrillValidator implements ISignatureValidator {
  readonly platform = 'mandrill';

  constructor(
    private readonly secret?: string,
    private readonly webhookUrl?: string,
  ) {}

  validate(rawPayload: string, headers: Record<string, string>): boolean {
    if (!this.secret || !this.webhookUrl) return false;
    const provided = getHeader(headers, 'X-Mandrill-Signature');
    if (!provided) return false;

    const params = new URLSearchParams(rawPayload);
    const entries = [...params.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    let signedData = this.webhookUrl;
    for (const [key, value] of entries) signedData += key + value;

    const expected = createHmac('sha1', this.secret)
      .update(signedData, 'utf8')
      .digest('base64');
    return safeEqual(expected, provided);
  }
}
