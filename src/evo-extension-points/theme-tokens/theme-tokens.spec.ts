import { EvoExtensionPoints } from '../registry';
import { ThemeTokensService } from './theme-tokens.service';

describe('ThemeTokensService', () => {
  let service: ThemeTokensService;

  beforeEach(() => {
    service = new ThemeTokensService();
    EvoExtensionPoints.reset();
  });

  it('returns an empty object under the community default', async () => {
    expect(await service.getTokens()).toEqual({});
    expect(await service.getTokens(null)).toEqual({});
    expect(await service.getTokens('scope-1')).toEqual({});
  });

  it('forwards the scope id to the registered provider', async () => {
    const providerSpy = jest.fn(() =>
      Promise.resolve({ brand_name: 'BrandName' }),
    );
    EvoExtensionPoints.replace('theme_tokens', providerSpy);

    const result = await service.getTokens('scope-A');

    expect(providerSpy).toHaveBeenCalledWith('scope-A');
    expect(result).toEqual({ brand_name: 'BrandName' });
  });

  it('honors null scope when forwarding', async () => {
    const providerSpy = jest.fn((scope: string | null) =>
      Promise.resolve({ brand_name: scope ? 'Scoped' : 'Unscoped' }),
    );
    EvoExtensionPoints.replace('theme_tokens', providerSpy);

    expect(await service.getTokens(null)).toEqual({ brand_name: 'Unscoped' });
    expect(providerSpy).toHaveBeenCalledWith(null);
  });
});
