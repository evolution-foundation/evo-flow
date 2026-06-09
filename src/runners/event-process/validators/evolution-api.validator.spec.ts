import { EvolutionApiValidator } from './evolution-api.validator';

describe('EvolutionApiValidator', () => {
  const token = 'evo-token';

  it('accepts a matching apikey header', () => {
    expect(
      new EvolutionApiValidator(token).validate('{}', { apikey: token }),
    ).toBe(true);
  });

  it('accepts a matching Authorization Bearer token', () => {
    expect(
      new EvolutionApiValidator(token).validate('{}', {
        Authorization: `Bearer ${token}`,
      }),
    ).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(
      new EvolutionApiValidator(token).validate('{}', { apikey: 'nope' }),
    ).toBe(false);
  });

  it('rejects when no token is configured', () => {
    expect(
      new EvolutionApiValidator(undefined).validate('{}', { apikey: token }),
    ).toBe(false);
  });
});
