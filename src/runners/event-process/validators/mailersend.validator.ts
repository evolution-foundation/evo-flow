import { createHmac } from 'crypto';
import { ISignatureValidator } from './signature-validator.interface';
import { getHeader, safeEqual } from './signature-validator.util';

/** MailerSend: HMAC-SHA256 (hex) of the raw body, header `Signature`. */
export class MailerSendValidator implements ISignatureValidator {
  readonly platform = 'mailersend';

  constructor(private readonly secret?: string) {}

  validate(rawPayload: string, headers: Record<string, string>): boolean {
    if (!this.secret) return false;
    const provided = getHeader(headers, 'Signature');
    if (!provided) return false;
    const expected = createHmac('sha256', this.secret)
      .update(rawPayload, 'utf8')
      .digest('hex');
    return safeEqual(expected, provided);
  }
}
