export const EVO_EXTENSION_POINTS_VERSION = '1.0.0';

export const EXTENSION_POINT_VERSIONS = Object.freeze({
  capability_gate: '1.0.0',
  runtime_context: '1.0.0',
  plugin_loader: '1.0.0',
  theme_tokens: '1.0.0',
} as const);

export type ExtensionPointName = keyof typeof EXTENSION_POINT_VERSIONS;
