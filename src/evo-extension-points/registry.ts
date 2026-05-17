import type { Request } from 'express';
import type { DynamicModule } from '@nestjs/common';
import { ExtensionPointName } from './version';

export type CapabilityGateImpl = (
  name: string,
  context: Record<string, unknown>,
) => boolean;

export interface RuntimeContext {
  request_id: string;
  user_id: string | null;
  scope_id: string | null;
  feature_flags: Record<string, boolean>;
  [key: string]: unknown;
}

export type RuntimeContextImpl = (
  req: Request,
  defaultContext: RuntimeContext,
) => Promise<RuntimeContext> | RuntimeContext;

export interface PluginLoaderOptions {
  modules: DynamicModule[];
  onLoad?: (loaded: string[]) => void;
}

export type PluginLoaderImpl = () =>
  | PluginLoaderOptions
  | Promise<PluginLoaderOptions>;

export interface ThemeTokens {
  brand_name?: string;
  logo_url?: string;
  primary_color?: string;
  support_email?: string;
  sender_name?: string;
  [key: string]: string | undefined;
}

export type ThemeTokensImpl = (
  scopeId: string | null,
) => Promise<ThemeTokens> | ThemeTokens;

export interface ExtensionPointImplementations {
  capability_gate: CapabilityGateImpl;
  runtime_context: RuntimeContextImpl;
  plugin_loader: PluginLoaderImpl;
  theme_tokens: ThemeTokensImpl;
}

const defaultCapabilityGate: CapabilityGateImpl = () => true;

const defaultRuntimeContext: RuntimeContextImpl = (_req, defaultContext) =>
  defaultContext;

const defaultPluginLoader: PluginLoaderImpl = () => ({ modules: [] });

const defaultThemeTokens: ThemeTokensImpl = () => ({});

class ExtensionPointRegistry {
  private readonly implementations: ExtensionPointImplementations = {
    capability_gate: defaultCapabilityGate,
    runtime_context: defaultRuntimeContext,
    plugin_loader: defaultPluginLoader,
    theme_tokens: defaultThemeTokens,
  };

  replace<K extends ExtensionPointName>(
    name: K,
    impl: ExtensionPointImplementations[K],
  ): void {
    if (!(name in this.implementations)) {
      throw new Error(`Unknown extension point: ${String(name)}`);
    }
    if (typeof impl !== 'function') {
      throw new TypeError(
        `Extension point '${String(name)}' implementation must be a function`,
      );
    }
    this.implementations[name] = impl;
  }

  get<K extends ExtensionPointName>(name: K): ExtensionPointImplementations[K] {
    return this.implementations[name];
  }

  reset(): void {
    this.implementations.capability_gate = defaultCapabilityGate;
    this.implementations.runtime_context = defaultRuntimeContext;
    this.implementations.plugin_loader = defaultPluginLoader;
    this.implementations.theme_tokens = defaultThemeTokens;
  }
}

export const EvoExtensionPoints = new ExtensionPointRegistry();
