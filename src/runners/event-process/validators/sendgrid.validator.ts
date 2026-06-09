import { createPublicKey, createVerify } from 'crypto';
import { ISignatureValidator } from './signature-validator.interface';
import { getHeader } from './signature-validator.util';

const SIGNATURE_HEADER = 'X-Twilio-Email-Event-Webhook-Signature';
const TIMESTAMP_HEADER = 'X-Twilio-Email-Event-Webhook-Timestamp';

/**
 * SendGrid: ECDSA signature over `timestamp + rawPayload`, headers
 * `X-Twilio-Email-Event-Webhook-Signature` (base64) + `…-Timestamp`. The
 * verification key is an optional base64 EC public key (SPKI/DER).
 *
 * When no key is configured the validator passes through: the channel ships
 * without signed event webhooks today, so signature verification is opt-in via
 * env rather than fail-closed (unlike the other providers).
 */
export class SendGridValidator implements ISignatureValidator {
  readonly platform = 'sendgrid';

  constructor(private readonly verificationKey?: string) {}

  validate(rawPayload: string, headers: Record<string, string>): boolean {
    if (!this.verificationKey) return true;
    const signature = getHeader(headers, SIGNATURE_HEADER);
    const timestamp = getHeader(headers, TIMESTAMP_HEADER);
    if (!signature || !timestamp) return false;
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(this.verificationKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      // SendGrid sends an ASN.1/DER-encoded ECDSA signature, which is what
      // Node's verify expects by default (dsaEncoding 'der'). Not exercised
      // against a real SendGrid payload here — that smoke is deferred to Growth
      // per the story scope.
      return createVerify('sha256')
        .update(timestamp + rawPayload, 'utf8')
        .verify(publicKey, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }
}
