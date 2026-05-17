import { Module } from '@nestjs/common';
import { ThemeTokensService } from './theme-tokens.service';

@Module({
  providers: [ThemeTokensService],
  exports: [ThemeTokensService],
})
export class ThemeTokensModule {}
