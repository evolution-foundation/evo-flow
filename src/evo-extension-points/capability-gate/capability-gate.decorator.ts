import { SetMetadata } from '@nestjs/common';

export const CAPABILITY_GATE_KEY = 'evo_capability_gate';

export const CapabilityGate = (name: string) =>
  SetMetadata(CAPABILITY_GATE_KEY, name);
