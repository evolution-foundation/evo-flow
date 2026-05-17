import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CapabilityGateGuard } from './capability-gate.guard';

@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: CapabilityGateGuard,
    },
    CapabilityGateGuard,
  ],
  exports: [CapabilityGateGuard],
})
export class CapabilityGateModule {}
