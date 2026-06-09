import { SparkPostValidator } from './sparkpost.validator';

describe('SparkPostValidator', () => {
  const user = 'sp-user';
  const password = 'sp-pass';
  const basic =
    'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');

  it('accepts a matching Basic Auth header', () => {
    expect(
      new SparkPostValidator(user, password).validate('{}', {
        Authorization: basic,
      }),
    ).toBe(true);
  });

  it('rejects wrong credentials', () => {
    const wrong = 'Basic ' + Buffer.from('x:y', 'utf8').toString('base64');
    expect(
      new SparkPostValidator(user, password).validate('{}', {
        Authorization: wrong,
      }),
    ).toBe(false);
  });

  it('rejects a non-Basic Authorization header', () => {
    expect(
      new SparkPostValidator(user, password).validate('{}', {
        Authorization: 'Bearer token',
      }),
    ).toBe(false);
  });

  it('rejects when credentials are not configured', () => {
    expect(
      new SparkPostValidator(undefined, undefined).validate('{}', {
        Authorization: basic,
      }),
    ).toBe(false);
  });
});
