import { Injectable } from '@nestjs/common';
import { EvoExtensionPoints, ThemeTokens } from '../registry';

@Injectable()
export class ThemeTokensService {
  async getTokens(scopeId: string | null = null): Promise<ThemeTokens> {
    const provider = EvoExtensionPoints.get('theme_tokens');
    return provider(scopeId);
  }
}
