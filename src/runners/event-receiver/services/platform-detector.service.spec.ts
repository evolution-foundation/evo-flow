import { PlatformDetectorService } from './platform-detector.service';

describe('PlatformDetectorService', () => {
  const detector = new PlatformDetectorService();

  it.each([
    'evolution-api',
    'sparkpost',
    'sendgrid',
    'mailersend',
    'resend',
    'ses',
    'mandrill',
  ])('resolves the known provider "%s" from the path segment', (platform) => {
    expect(detector.detect(platform)).toBe(platform);
  });

  it('takes only the first segment of a multi-segment path', () => {
    expect(detector.detect('evolution-api/instance-1')).toBe('evolution-api');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(detector.detect('  Evolution-API  ')).toBe('evolution-api');
  });

  it.each<[string | undefined]>([['foo'], [''], [undefined]])(
    'falls back to "unknown" for unrecognized segment %p',
    (segment) => {
      expect(detector.detect(segment)).toBe('unknown');
    },
  );

  it('resolves the whitelisted "unknown" segment to itself (not a fallback)', () => {
    expect(detector.detect('unknown')).toBe('unknown');
  });
});
