/**
 * Minimal type shim for `sns-validator` (no bundled types, no @types package).
 * Only the surface the SES signature validator uses is declared.
 */
declare module 'sns-validator' {
  type SnsMessage = Record<string, unknown>;
  type ValidateCallback = (err: Error | null, message?: SnsMessage) => void;

  class MessageValidator {
    constructor(hostPattern?: RegExp, encoding?: string);
    validate(message: SnsMessage | string, cb: ValidateCallback): void;
  }

  export = MessageValidator;
}
