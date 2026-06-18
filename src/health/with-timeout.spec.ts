import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves the value when work finishes in time', async () => {
    await expect(
      withTimeout(() => Promise.resolve(42), 1000, 'x'),
    ).resolves.toBe(42);
  });

  it('rejects with a labeled timeout error when work overruns', async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 50));
    await expect(withTimeout(slow, 10, 'postgres')).rejects.toThrow(
      'postgres health check timed out after 10ms',
    );
  });

  it('propagates the original rejection', async () => {
    const boom = () => Promise.reject(new Error('boom'));
    await expect(withTimeout(boom, 1000, 'x')).rejects.toThrow('boom');
  });
});
