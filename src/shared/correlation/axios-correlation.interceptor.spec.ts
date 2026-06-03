jest.mock('./correlation.util', () => ({
  readCorrelationIdFromCls: jest.fn(),
}));

import { applyCorrelationHeader } from './axios-correlation.interceptor';
import { readCorrelationIdFromCls } from './correlation.util';

const mockRead = readCorrelationIdFromCls as jest.Mock;

function makeFakeAxios() {
  let registered: (config: any) => any = (c) => c;
  return {
    interceptors: {
      request: { use: (fn: (c: any) => any) => (registered = fn) },
    },
    fire: (config: any) => registered(config),
  };
}

describe('applyCorrelationHeader (axios outbound)', () => {
  afterEach(() => mockRead.mockReset());

  it('injects X-Correlation-Id from the current context (AC4)', () => {
    mockRead.mockReturnValue('cid-42');
    const axiosInstance = makeFakeAxios();
    applyCorrelationHeader(axiosInstance as any);

    const headers = { set: jest.fn() };
    axiosInstance.fire({ headers });

    expect(headers.set).toHaveBeenCalledWith('x-correlation-id', 'cid-42');
  });

  it('does not set the header when there is no correlation id in context', () => {
    mockRead.mockReturnValue(undefined);
    const axiosInstance = makeFakeAxios();
    applyCorrelationHeader(axiosInstance as any);

    const headers = { set: jest.fn() };
    axiosInstance.fire({ headers });

    expect(headers.set).not.toHaveBeenCalled();
  });
});
