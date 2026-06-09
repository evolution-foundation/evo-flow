import { ISignatureValidator } from './signature-validator.interface';
import { getHeader, safeEqual } from './signature-validator.util';

/** SparkPost: HTTP Basic Auth on the webhook request (`Authorization: Basic …`). */
export class SparkPostValidator implements ISignatureValidator {
  readonly platform = 'sparkpost';

  constructor(
    private readonly user?: string,
    private readonly password?: string,
  ) {}

  validate(_rawPayload: string, headers: Record<string, string>): boolean {
    if (!this.user || !this.password) return false;
    const provided = getHeader(headers, 'Authorization');
    if (!provided?.startsWith('Basic ')) return false;
    const expected =
      'Basic ' +
      Buffer.from(`${this.user}:${this.password}`, 'utf8').toString('base64');
    return safeEqual(expected, provided);
  }
}
