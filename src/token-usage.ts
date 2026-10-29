import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';

export const TOKEN_USAGE_ROUTE = '/tlon/token-usage';

type UsageTotals = {
  usageReport?: unknown;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
};

type UsageReport = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  totals: UsageTotals;
  aggregates: { byProvider: Array<{ provider?: string; totals: UsageTotals }> };
  partial?: unknown;
  cacheStatus?: unknown;
};

function tokens(totals: UsageTotals): UsageTotals {
  return {
    ...(totals.usageReport ? { usageReport: totals.usageReport } : {}),
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    totalTokens: totals.totalTokens,
  };
}

function isDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function registerTokenUsageRoute(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: TOKEN_USAGE_ROUTE,
    auth: 'gateway',
    match: 'exact',
    gatewayRuntimeScopeSurface: 'trusted-operator',
    handler: async (req, res) => {
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        json(405, { error: 'method not allowed' });
        return;
      }
      const url = new URL(req.url ?? TOKEN_USAGE_ROUTE, 'http://localhost');
      const today = new Date().toISOString().slice(0, 10);
      const startDate =
        url.searchParams.get('startDate') ?? `${today.slice(0, 7)}-01`;
      const endDate = url.searchParams.get('endDate') ?? today;
      if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) {
        json(400, {
          error: 'startDate and endDate must be ordered YYYY-MM-DD dates',
        });
        return;
      }
      try {
        const report = (await api.runtime.gateway.request('sessions.usage', {
          startDate,
          endDate,
          mode: 'utc',
          agentScope: 'all',
          groupBy: 'family',
          limit: 1,
          includeContextWeight: false,
        })) as UsageReport;
        // Project only usage: the gateway response also contains session identities.
        json(200, {
          updatedAt: report.updatedAt,
          startDate: report.startDate,
          endDate: report.endDate,
          keyAttribution: 'unavailable',
          totals: tokens(report.totals),
          byProvider: report.aggregates.byProvider.map(
            ({ provider, totals }) => ({
              provider,
              ...tokens(totals),
            })
          ),
          ...(report.partial ? { partial: report.partial } : {}),
          ...(report.cacheStatus ? { cacheStatus: report.cacheStatus } : {}),
        });
      } catch {
        json(502, { error: 'OpenClaw token usage is unavailable' });
      }
    },
  });
}
