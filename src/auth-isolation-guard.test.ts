import { describe, expect, it, vi } from 'vitest';

import {
  assertMonolithicDefaultAuthStoreEmpty,
  registerAuthIsolationGuard,
} from './auth-isolation-guard.js';

const monolithic = {
  channels: { tlon: { deploymentMode: 'monolithic' } },
};

describe('monolithic auth isolation', () => {
  it('rejects credentials in the shared default-agent store', () => {
    expect(() =>
      assertMonolithicDefaultAuthStoreEmpty(monolithic, ['xai:default'])
    ).toThrow(/default agent auth store/);
  });

  it('allows an empty default store and leaves standalone behavior unchanged', () => {
    expect(() =>
      assertMonolithicDefaultAuthStoreEmpty(monolithic, [])
    ).not.toThrow();
    expect(() =>
      assertMonolithicDefaultAuthStoreEmpty({}, ['xai:default'])
    ).not.toThrow();
  });

  it('registers an awaited gateway startup service', () => {
    const registerService = vi.fn();
    registerAuthIsolationGuard({ registerService } as never);
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tlon-hosting-auth-isolation',
        start: expect.any(Function),
      })
    );
  });
});
