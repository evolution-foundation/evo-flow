import { DynamicModule, Module } from '@nestjs/common';
import { EvoExtensionPoints } from '../registry';
import { PluginLoaderModule } from './plugin-loader.module';
import { PLUGIN_LOADER_OPTIONS } from './plugin-loader.types';

describe('PluginLoaderModule.forRootAsync', () => {
  beforeEach(() => {
    EvoExtensionPoints.reset();
  });

  it('returns an empty modules list under the community default (no-op)', async () => {
    const dynamic = await PluginLoaderModule.forRootAsync();
    expect(dynamic.imports).toEqual([]);
    expect(dynamic.module).toBe(PluginLoaderModule);
  });

  it('does not throw and does not log on the community default', async () => {
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await PluginLoaderModule.forRootAsync();

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('exposes a PLUGIN_LOADER_OPTIONS provider', async () => {
    const dynamic = await PluginLoaderModule.forRootAsync();
    const provider = dynamic.providers?.find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' &&
        'provide' in p &&
        p.provide === PLUGIN_LOADER_OPTIONS,
    );
    expect(provider).toBeDefined();
  });

  it('loads consumer modules and invokes onLoad when replaced', async () => {
    @Module({})
    class FakeModuleA {}

    @Module({})
    class FakeModuleB {}

    const onLoad = jest.fn();
    EvoExtensionPoints.replace('plugin_loader', () => ({
      modules: [FakeModuleA, FakeModuleB] as unknown as DynamicModule[],
      onLoad,
    }));

    const dynamic = await PluginLoaderModule.forRootAsync();

    expect(dynamic.imports).toHaveLength(2);
    expect(onLoad).toHaveBeenCalledTimes(1);
    const firstCallArgs = onLoad.mock.calls[0] as [string[]];
    expect(firstCallArgs[0]).toHaveLength(2);
  });
});
