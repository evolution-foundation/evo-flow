const mockValidate = jest.fn();

jest.mock('sns-validator', () =>
  jest.fn().mockImplementation(() => ({
    validate: mockValidate,
  })),
);

import { SesValidator } from './ses.validator';

// NOTE: the real SNS signature crypto (certificate fetch + RSA verify) is
// mocked out — it cannot run offline. These tests cover the synchronous guards
// (Type, cert-URL allowlist) and the pass/fail wiring around the validator
// callback; the real crypto path is left to manual/Growth smoke per the story.
describe('SesValidator', () => {
  beforeEach(() => mockValidate.mockReset());

  const message = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      Type: 'Notification',
      SignatureVersion: '1',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
      Signature: 'base64sig',
      Message: '{}',
      ...over,
    });

  it('accepts a structurally valid SNS message whose signature verifies', async () => {
    mockValidate.mockImplementation(
      (_m: unknown, cb: (e: Error | null) => void) => cb(null),
    );
    expect(await new SesValidator().validate(message())).toBe(true);
  });

  it('rejects when the signing-cert URL is not an amazonaws host (no crypto call)', async () => {
    expect(
      await new SesValidator().validate(
        message({ SigningCertURL: 'https://evil.example.com/cert.pem' }),
      ),
    ).toBe(false);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  // EVO-1210 B2: a forged cert hosted on a public S3 bucket is still
  // *.amazonaws.com but is NOT a real SNS signing host — must be rejected.
  it('rejects a cert hosted on a non-SNS amazonaws host (S3 bucket forgery)', async () => {
    expect(
      await new SesValidator().validate(
        message({
          SigningCertURL: 'https://attacker-bucket.s3.amazonaws.com/cert.pem',
        }),
      ),
    ).toBe(false);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('rejects when the SNS signature does not verify', async () => {
    mockValidate.mockImplementation(
      (_m: unknown, cb: (e: Error | null) => void) =>
        cb(new Error('bad signature')),
    );
    expect(await new SesValidator().validate(message())).toBe(false);
  });

  it('rejects a non-JSON payload or an unsupported SNS Type', async () => {
    expect(await new SesValidator().validate('not-json')).toBe(false);
    expect(
      await new SesValidator().validate(message({ Type: 'Whatever' })),
    ).toBe(false);
  });
});
