import { createHmac } from 'crypto';
import { MailerSendValidator } from './mailersend.validator';

describe('MailerSendValidator', () => {
  const secret = 'ms-secret';
  const body = '{"type":"activity.opened"}';
  const sign = (s: string, b: string) =>
    createHmac('sha256', s).update(b, 'utf8').digest('hex');

  it('accepts a valid HMAC-SHA256 signature', () => {
    const v = new MailerSendValidator(secret);
    expect(v.validate(body, { Signature: sign(secret, body) })).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const v = new MailerSendValidator(secret);
    expect(v.validate(body, { Signature: sign('wrong', body) })).toBe(false);
  });

  it('rejects when no secret is configured (fail-closed)', () => {
    const v = new MailerSendValidator(undefined);
    expect(v.validate(body, { Signature: sign(secret, body) })).toBe(false);
  });

  it('rejects when the Signature header is missing', () => {
    expect(new MailerSendValidator(secret).validate(body, {})).toBe(false);
  });
});
