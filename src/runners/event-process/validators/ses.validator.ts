import { ISignatureValidator } from './signature-validator.interface';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import MessageValidator = require('sns-validator');

// Must match sns-validator's own default: only real SNS signing-cert hosts
// (`sns.<region>.amazonaws.com`). A looser `*.amazonaws.com` pattern is
// forgeable — an attacker can host a cert on a public S3 bucket
// (`*.s3.amazonaws.com`) — so we deliberately do NOT widen it.
const SNS_CERT_HOST = /^sns\.[a-zA-Z0-9-]{3,}\.amazonaws\.com(\.cn)?$/;
const SNS_TYPES = [
  'Notification',
  'SubscriptionConfirmation',
  'UnsubscribeConfirmation',
];

/**
 * Amazon SES via SNS. Validates the SNS message signature with `sns-validator`
 * (which fetches + caches the signing certificate over HTTPS — hence async),
 * after a synchronous guard on Type and the strict SNS signing-cert host check.
 * We rely on the library's secure default host pattern (no custom override).
 */
export class SesValidator implements ISignatureValidator {
  readonly platform = 'ses';
  private readonly validator = new MessageValidator();

  async validate(rawPayload: string): Promise<boolean> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(rawPayload) as Record<string, unknown>;
    } catch {
      return false;
    }

    if (typeof message.Type !== 'string' || !SNS_TYPES.includes(message.Type)) {
      return false;
    }
    const certUrl = message.SigningCertURL ?? message.SigningCertUrl;
    if (typeof certUrl !== 'string' || !this.isAmazonUrl(certUrl)) return false;

    return new Promise<boolean>((resolve) => {
      this.validator.validate(message, (err) => resolve(!err));
    });
  }

  private isAmazonUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && SNS_CERT_HOST.test(url.hostname);
    } catch {
      return false;
    }
  }
}
