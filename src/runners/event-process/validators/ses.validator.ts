import { ISignatureValidator } from './signature-validator.interface';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import MessageValidator = require('sns-validator');

const AMAZON_HOST = /(^|\.)amazonaws\.com$/;
const SNS_TYPES = [
  'Notification',
  'SubscriptionConfirmation',
  'UnsubscribeConfirmation',
];

/**
 * Amazon SES via SNS. Validates the SNS message signature with `sns-validator`
 * (which fetches + caches the signing certificate over HTTPS — hence async),
 * after a synchronous guard on Type and a `.amazonaws.com` allowlist for the
 * signing-cert URL.
 */
export class SesValidator implements ISignatureValidator {
  readonly platform = 'ses';
  private readonly validator = new MessageValidator(AMAZON_HOST);

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
      return url.protocol === 'https:' && AMAZON_HOST.test(url.hostname);
    } catch {
      return false;
    }
  }
}
