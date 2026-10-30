import { beforeEach, describe, expect, it } from 'vitest';
import { activeNetwork, apiPath, scopedKey, selectNetwork } from './network';

describe('network scope', () => {
  beforeEach(() => localStorage.clear());

  it('leaves paths and keys alone until a non-default network is chosen', () => {
    expect(activeNetwork()).toBeNull();
    expect(apiPath('/v2/analyze/abc')).toBe('/v2/analyze/abc');
    expect(scopedKey('feepilot.fees.v1')).toBe('feepilot.fees.v1');
  });

  it('routes /v2 calls and local data to the chosen network', () => {
    selectNetwork('signet', 'regtest');
    expect(activeNetwork()).toBe('signet');
    expect(apiPath('/v2/analyze/abc')).toBe('/net/signet/v2/analyze/abc');
    expect(scopedKey('feepilot-queue')).toBe('feepilot-queue.signet');
  });

  it('asks the network list without a prefix', () => {
    selectNetwork('signet', 'regtest');
    expect(apiPath('/v2/networks')).toBe('/v2/networks');
    expect(apiPath('/health')).toBe('/health');
  });

  it('picking the default clears the choice, so default data keeps its original keys', () => {
    selectNetwork('signet', 'regtest');
    selectNetwork('regtest', 'regtest');
    expect(activeNetwork()).toBeNull();
    expect(scopedKey('feepilot-queue')).toBe('feepilot-queue');
  });

  it('ignores a malformed saved value', () => {
    localStorage.setItem('feepilot.network.v1', '../evil');
    expect(activeNetwork()).toBeNull();
  });
});
