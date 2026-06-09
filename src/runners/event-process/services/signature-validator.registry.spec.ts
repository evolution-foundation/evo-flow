import { ConfigService } from '@nestjs/config';
import { SignatureValidatorRegistry } from './signature-validator.registry';

describe('SignatureValidatorRegistry', () => {
  const config = {
    get: jest.fn().mockReturnValue('configured-secret'),
  } as unknown as ConfigService;
  const registry = new SignatureValidatorRegistry(config);

  it.each([
    'evolution-api',
    'sparkpost',
    'sendgrid',
    'mailersend',
    'resend',
    'ses',
    'mandrill',
  ])('resolves a validator for %s', (platform) => {
    const validator = registry.for(platform);
    expect(validator).not.toBeNull();
    expect(validator?.platform).toBe(platform);
  });

  it('returns null for the unknown platform', () => {
    expect(registry.for('unknown')).toBeNull();
  });

  it('returns null for an unregistered platform', () => {
    expect(registry.for('not-a-platform')).toBeNull();
  });
});
