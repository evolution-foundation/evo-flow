import { Webhook } from 'svix';
import { ResendValidator } from './resend.validator';

describe('ResendValidator', () => {
  // Svix signing secrets are base64, optionally `whsec_`-prefixed.
  const secret =
    'whsec_' +
    Buffer.from('resend-signing-secret-key-1234', 'utf8').toString('base64');
  const id = 'msg_2abc';
  // Use a current timestamp so it falls inside Svix's signature tolerance window.
  const now = new Date();
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const payload = '{"type":"email.delivered"}';
  const signature = new Webhook(secret).sign(id, now, payload);

  const headers = {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': signature,
  };

  it('accepts a valid Svix signature', () => {
    expect(new ResendValidator(secret).validate(payload, headers)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    expect(new ResendValidator(secret).validate(payload + 'x', headers)).toBe(
      false,
    );
  });

  it('rejects when no secret is configured', () => {
    expect(new ResendValidator(undefined).validate(payload, headers)).toBe(
      false,
    );
  });
});
