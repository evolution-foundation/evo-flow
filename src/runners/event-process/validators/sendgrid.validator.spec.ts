import { generateKeyPairSync, createSign } from 'crypto';
import { SendGridValidator } from './sendgrid.validator';

describe('SendGridValidator', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const verificationKey = publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
  const timestamp = '1609459200';
  const body = '[{"event":"delivered"}]';
  const signature = createSign('sha256')
    .update(timestamp + body, 'utf8')
    .sign(privateKey)
    .toString('base64');

  const headers = {
    'X-Twilio-Email-Event-Webhook-Signature': signature,
    'X-Twilio-Email-Event-Webhook-Timestamp': timestamp,
  };

  it('passes through when no verification key is configured (opt-in)', () => {
    expect(new SendGridValidator(undefined).validate(body, {})).toBe(true);
  });

  it('accepts a valid ECDSA signature when a key is configured', () => {
    expect(new SendGridValidator(verificationKey).validate(body, headers)).toBe(
      true,
    );
  });

  it('rejects a tampered payload', () => {
    expect(
      new SendGridValidator(verificationKey).validate(body + 'x', headers),
    ).toBe(false);
  });

  it('rejects when signature/timestamp headers are missing', () => {
    expect(new SendGridValidator(verificationKey).validate(body, {})).toBe(
      false,
    );
  });
});
