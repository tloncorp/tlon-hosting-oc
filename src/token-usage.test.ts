import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerTokenUsageRoute, TOKEN_USAGE_ROUTE } from './token-usage.js';

const totals = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 5,
  totalTokens: 155,
};

function setup() {
  const request = vi.fn().mockResolvedValue({
    updatedAt: 123,
    startDate: '2026-10-01',
    endDate: '2026-10-29',
    totals: { ...totals, totalCost: 99 },
    sessions: [{ key: 'private-session', label: 'private-conversation' }],
    aggregates: { byProvider: [{ provider: 'openrouter', totals }] },
  });
  const registerHttpRoute = vi.fn<OpenClawPluginApi['registerHttpRoute']>();
  registerTokenUsageRoute({
    registerHttpRoute,
    runtime: { gateway: { request } },
  } as unknown as OpenClawPluginApi);
  const route = registerHttpRoute.mock.calls[0][0];
  const call = async (method = 'GET', query = '') => {
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await route.handler(
      { method, url: `${TOKEN_USAGE_ROUTE}${query}` } as IncomingMessage,
      res as unknown as ServerResponse
    );
    return {
      status: res.statusCode,
      headers: res.setHeader,
      body: JSON.parse(res.end.mock.calls[0][0]),
    };
  };
  return { route, request, call };
}

afterEach(() => vi.useRealTimers());

describe('token usage route', () => {
  it('requires gateway auth and returns only aggregate token data across agents and session rotations', async () => {
    const { route, request, call } = setup();
    expect(route).toMatchObject({
      path: TOKEN_USAGE_ROUTE,
      auth: 'gateway',
      match: 'exact',
      gatewayRuntimeScopeSurface: 'trusted-operator',
    });
    const response = await call(
      'GET',
      '?startDate=2026-10-01&endDate=2026-10-29'
    );
    expect(request).toHaveBeenCalledWith('sessions.usage', {
      startDate: '2026-10-01',
      endDate: '2026-10-29',
      mode: 'utc',
      agentScope: 'all',
      groupBy: 'family',
      limit: 1,
      includeContextWeight: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      updatedAt: 123,
      startDate: '2026-10-01',
      endDate: '2026-10-29',
      keyAttribution: 'unavailable',
      totals,
      byProvider: [{ provider: 'openrouter', ...totals }],
    });
  });

  it('defaults to the current UTC month', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T23:59:00Z'));
    const { request, call } = setup();
    await call();
    expect(request.mock.calls[0][1]).toMatchObject({
      startDate: '2026-10-01',
      endDate: '2026-10-29',
    });
  });

  it.each([
    '?startDate=2026-02-30',
    '?endDate=bad',
    '?startDate=2026-10-30&endDate=2026-10-01',
  ])('rejects invalid dates: %s', async (query) => {
    const { request, call } = setup();
    expect((await call('GET', query)).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves partial-data markers so missing coverage is not presented as zero usage', async () => {
    const { request, call } = setup();
    const partial = {
      reason: 'time-budget',
      message: 'Usage is still computing',
    };
    request.mockResolvedValue({
      totals: { ...totals, usageReport: { status: 'unavailable' } },
      aggregates: { byProvider: [] },
      partial,
      cacheStatus: { status: 'partial' },
    });
    expect((await call()).body).toMatchObject({
      totals: { usageReport: { status: 'unavailable' } },
      partial,
      cacheStatus: { status: 'partial' },
    });
  });

  it('rejects writes and reports upstream failure without leaking gateway errors', async () => {
    const { request, call } = setup();
    const write = await call('POST');
    expect(write.status).toBe(405);
    expect(write.headers).toHaveBeenCalledWith('Allow', 'GET');
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValue(new Error('private gateway error'));
    expect(await call()).toMatchObject({
      status: 502,
      body: { error: 'OpenClaw token usage is unavailable' },
    });
  });
});
