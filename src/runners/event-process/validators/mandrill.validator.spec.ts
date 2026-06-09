import { createHmac } from 'crypto';
import { MandrillValidator } from './mandrill.validator';

describe('MandrillValidator', () => {
  const secret = 'md-key';
  const url = 'https://hook.evo/webhooks/mandrill';
  const body =
    'mandrill_events=' + encodeURIComponent('[{"event":"hard_bounce"}]');

  const sign = (s: string) => {
    const params = new URLSearchParams(body);
    const entries = [...params.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    let data = url;
    for (const [k, v] of entries) data += k + v;
    return createHmac('sha1', s).update(data, 'utf8').digest('base64');
  };

  it('accepts a valid HMAC-SHA1 signature', () => {
    const v = new MandrillValidator(secret, url);
    expect(v.validate(body, { 'X-Mandrill-Signature': sign(secret) })).toBe(
      true,
    );
  });

  it('rejects a signature computed with the wrong secret', () => {
    const v = new MandrillValidator(secret, url);
    expect(v.validate(body, { 'X-Mandrill-Signature': sign('nope') })).toBe(
      false,
    );
  });

  it('rejects when the webhook URL or secret is missing', () => {
    expect(
      new MandrillValidator(undefined, url).validate(body, {
        'X-Mandrill-Signature': sign(secret),
      }),
    ).toBe(false);
    expect(
      new MandrillValidator(secret, undefined).validate(body, {
        'X-Mandrill-Signature': sign(secret),
      }),
    ).toBe(false);
  });
});
