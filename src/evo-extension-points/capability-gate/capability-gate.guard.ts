import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EvoExtensionPoints } from '../registry';
import { CAPABILITY_GATE_KEY } from './capability-gate.decorator';

@Injectable()
export class CapabilityGateGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const capabilityName = this.reflector.getAllAndOverride<string | undefined>(
      CAPABILITY_GATE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!capabilityName) return true;

    const gate = EvoExtensionPoints.get('capability_gate');
    const request = context
      .switchToHttp()
      .getRequest<Record<string, unknown>>();
    const requestContext =
      (request['runtime_context'] as Record<string, unknown>) ?? {};

    const allowed = gate(capabilityName, requestContext);
    if (!allowed) {
      throw new ForbiddenException({
        error: 'CAPABILITY_DENIED',
        capability: capabilityName,
      });
    }
    return true;
  }
}
