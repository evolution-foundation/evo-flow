import { EvoExtensionPoints, RuntimeContext } from './registry';

describe('EvoExtensionPoints registry', () => {
  afterEach(() => {
    EvoExtensionPoints.reset();
  });

  describe('defaults (no-op behavior)', () => {
    it('capability_gate default permits everything', () => {
      const gate = EvoExtensionPoints.get('capability_gate');
      expect(gate('journey.duplicate', {})).toBe(true);
      expect(gate('campaigns.ab_test', { user_id: '42' })).toBe(true);
    });

    it('runtime_context default returns the unchanged default context', async () => {
      const enricher = EvoExtensionPoints.get('runtime_context');
      const defaultCtx: RuntimeContext = {
        request_id: 'req-1',
        user_id: 'user-1',
        scope_id: null,
        feature_flags: {},
      };
      const result = await enricher({} as never, defaultCtx);
      expect(result).toBe(defaultCtx);
    });

    it('plugin_loader default returns an empty modules list', async () => {
      const loader = EvoExtensionPoints.get('plugin_loader');
      const options = await loader();
      expect(options.modules).toEqual([]);
    });

    it('theme_tokens default returns an empty object', async () => {
      const tokens = EvoExtensionPoints.get('theme_tokens');
      const result = await tokens(null);
      expect(result).toEqual({});
    });
  });

  describe('replace', () => {
    it('replaces a known extension point', () => {
      EvoExtensionPoints.replace('capability_gate', () => false);
      expect(EvoExtensionPoints.get('capability_gate')('any.key', {})).toBe(
        false,
      );
    });

    it('throws on unknown extension point name', () => {
      expect(() => {
        (
          EvoExtensionPoints as unknown as {
            replace: (n: string, i: unknown) => void;
          }
        ).replace('not_a_real_point', () => true);
      }).toThrow(/Unknown extension point/);
    });

    it('throws when implementation is not a function', () => {
      expect(() => {
        EvoExtensionPoints.replace(
          'capability_gate',
          'not-a-function' as never,
        );
      }).toThrow(TypeError);
    });
  });

  describe('reset', () => {
    it('restores all defaults', () => {
      EvoExtensionPoints.replace('capability_gate', () => false);
      EvoExtensionPoints.replace('theme_tokens', () => ({
        brand_name: 'X',
      }));
      EvoExtensionPoints.reset();

      expect(EvoExtensionPoints.get('capability_gate')('any', {})).toBe(true);
      const tokens = EvoExtensionPoints.get('theme_tokens');
      const result = tokens(null);
      return Promise.resolve(result).then((r) => expect(r).toEqual({}));
    });
  });
});
