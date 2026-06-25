import { WaitNode, WaitNodeInput } from './wait.node';

describe('WaitNode.resolveWaitHandle (EVO-1912)', () => {
  const make = (
    nodeData: Partial<WaitNodeInput['nodeData']> = {},
  ): WaitNodeInput => ({
    nodeId: 'wait-1',
    contactId: 'contact-1',
    sessionId: 'session-1',
    nodeData: { waitType: 'event', ...nodeData } as WaitNodeInput['nodeData'],
  });

  describe('hasMultipleOutputs', () => {
    it('is true when enableFallback is set', () => {
      expect(
        WaitNode.hasMultipleOutputs(make({ enableFallback: true }).nodeData),
      ).toBe(true);
    });

    it('is true for time_or_condition waits', () => {
      expect(
        WaitNode.hasMultipleOutputs(make({ waitType: 'time_or_condition' }).nodeData),
      ).toBe(true);
    });

    it('is false for a plain single-output wait', () => {
      expect(WaitNode.hasMultipleOutputs(make({ waitType: 'time' }).nodeData)).toBe(
        false,
      );
    });
  });

  describe('multi-output routing by FE handle', () => {
    it('routes success to the wait-success handle (no node-data ids needed)', () => {
      const handle = WaitNode.resolveWaitHandle(
        make({ enableFallback: true }),
        'success',
      );
      expect(handle).toBe('wait-success');
    });

    it('routes timeout to the wait-otherwise handle', () => {
      const handle = WaitNode.resolveWaitHandle(
        make({ enableFallback: true }),
        'timeout',
      );
      expect(handle).toBe('wait-otherwise');
    });

    it('routes cancelled to the wait-otherwise (fallback) handle', () => {
      const handle = WaitNode.resolveWaitHandle(
        make({ waitType: 'time_or_condition' }),
        'cancelled',
      );
      expect(handle).toBe('wait-otherwise');
    });

    it('uses the FE handle constants', () => {
      expect(WaitNode.SUCCESS_HANDLE).toBe('wait-success');
      expect(WaitNode.OTHERWISE_HANDLE).toBe('wait-otherwise');
    });
  });

  describe('single-output waits', () => {
    it('returns null so the workflow follows the single outgoing edge', () => {
      expect(
        WaitNode.resolveWaitHandle(make({ waitType: 'time' }), 'success'),
      ).toBeNull();
      expect(
        WaitNode.resolveWaitHandle(make({ waitType: 'time' }), 'timeout'),
      ).toBeNull();
    });
  });

  describe('legacy id-based processWaitCompletion is preserved', () => {
    it('honours successNodeId / otherwiseNodeId when present', () => {
      const input = make({
        enableFallback: true,
        successNodeId: 'node-ok',
        otherwiseNodeId: 'node-timeout',
      });
      expect(WaitNode.processWaitCompletion(input, 'success')).toBe('node-ok');
      expect(WaitNode.processWaitCompletion(input, 'timeout')).toBe('node-timeout');
    });

    it('returns null for multi-output when ids are absent (FE case → handle routing)', () => {
      const input = make({ enableFallback: true });
      expect(WaitNode.processWaitCompletion(input, 'success')).toBeNull();
      expect(WaitNode.processWaitCompletion(input, 'timeout')).toBeNull();
    });

    it('returns nextNodeId for single-output waits', () => {
      const input = make({ waitType: 'time', nextNodeId: 'node-next' });
      expect(WaitNode.processWaitCompletion(input, 'success')).toBe('node-next');
    });
  });
});
