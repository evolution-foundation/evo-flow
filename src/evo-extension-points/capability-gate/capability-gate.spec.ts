import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EvoExtensionPoints } from '../registry';
import { CapabilityGateGuard } from './capability-gate.guard';
import { CAPABILITY_GATE_KEY } from './capability-gate.decorator';

function buildContext(): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class Stub {},
    switchToHttp: () => ({
      getRequest: () => ({ runtime_context: { user_id: '42' } }),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => 'http',
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
  } as unknown as ExecutionContext;
}

describe('CapabilityGateGuard', () => {
  let guard: CapabilityGateGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new CapabilityGateGuard(reflector);
    EvoExtensionPoints.reset();
  });

  it('permits handlers without the decorator', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it('permits when default no-op gate is active (community runtime)', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('journey.duplicate');
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it('blocks when a consumer replaces the gate with a deny implementation', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue('campaigns.ab_test');
    EvoExtensionPoints.replace('capability_gate', () => false);

    expect(() => guard.canActivate(buildContext())).toThrow(ForbiddenException);
  });

  it('passes the capability name and runtime_context to the gate impl', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('feature.x');
    const gateSpy = jest.fn(() => true);
    EvoExtensionPoints.replace('capability_gate', gateSpy);

    guard.canActivate(buildContext());

    expect(gateSpy).toHaveBeenCalledWith('feature.x', { user_id: '42' });
  });
});

describe('CapabilityGate decorator', () => {
  it('attaches the capability name to handler metadata', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(CAPABILITY_GATE_KEY, 'journey.create', handler);
    expect(Reflect.getMetadata(CAPABILITY_GATE_KEY, handler)).toBe(
      'journey.create',
    );
  });
});
