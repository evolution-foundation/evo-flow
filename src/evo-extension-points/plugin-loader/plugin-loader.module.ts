import { DynamicModule, Module } from '@nestjs/common';
import { EvoExtensionPoints } from '../registry';
import { PLUGIN_LOADER_OPTIONS } from './plugin-loader.types';

@Module({})
export class PluginLoaderModule {
  static async forRootAsync(): Promise<DynamicModule> {
    const factory = EvoExtensionPoints.get('plugin_loader');
    const options = await factory();
    const loaded = options.modules.map(
      (m) => (m as { name?: string }).name ?? 'anonymous',
    );
    options.onLoad?.(loaded);

    return {
      module: PluginLoaderModule,
      imports: options.modules,
      providers: [
        {
          provide: PLUGIN_LOADER_OPTIONS,
          useValue: options,
        },
      ],
      exports: options.modules.length > 0 ? options.modules : [],
    };
  }
}
