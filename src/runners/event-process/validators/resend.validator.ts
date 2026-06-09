import { Webhook } from 'svix';
import { ISignatureValidator } from './signature-validator.interface';
import { getHeader } from './signature-validator.util';

/** Resend: Svix-signed webhooks (`svix-id`, `svix-timestamp`, `svix-signature`). */
export class ResendValidator implements ISignatureValidator {
  readonly platform = 'resend';

  constructor(private readonly secret?: string) {}

  validate(rawPayload: string, headers: Record<string, string>): boolean {
    if (!this.secret) return false;
    try {
      new Webhook(this.secret).verify(rawPayload, {
        'svix-id': getHeader(headers, 'svix-id') ?? '',
        'svix-timestamp': getHeader(headers, 'svix-timestamp') ?? '',
        'svix-signature': getHeader(headers, 'svix-signature') ?? '',
      });
      return true;
    } catch {
      return false;
    }
  }
}
