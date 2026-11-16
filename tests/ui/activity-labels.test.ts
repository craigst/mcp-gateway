import { describe, expect, it } from 'vitest';
import { activityAction, activityClient, activityServer, clientLabel } from '../../src/ui/lib/activity.js';
import type { AuditEntry, KeySummary, ServerRecord } from '../../src/core/types.js';

const base = { keyId: 'key-1', serverId: 'srv-1', method: 'tools/call', toolId: 'search', status: 'ok' } as AuditEntry;
const keys = [{ id: 'key-1', name: 'omb-remy' }] as KeySummary[];
const servers = [{ id: 'srv-1', name: 'brain' }] as ServerRecord[];

describe('activity labels', () => {
  it('shows configured names rather than opaque IDs', () => {
    expect(activityClient(base, keys)).toBe('Remy · omb-remy');
    expect(clientLabel('omb-home-henry')).toBe('Home Henry · omb-home-henry');
    expect(clientLabel('custom-client')).toBe('custom-client');
    expect(activityServer(base, servers)).toBe('brain');
    expect(activityAction(base)).toBe('Used search');
  });
  it('does not claim a denied operation succeeded or guess unknown owners', () => {
    expect(activityAction({ ...base, status: 'denied' })).toBe('Attempted search');
    expect(activityClient(base, [])).toBe('Unknown key (key-1)');
    expect(activityClient({ ...base, keyId: null }, keys)).toBe('Unidentified client');
    expect(activityAction({ ...base, method: 'initialize', status: 'error' })).toBe('Attempted to connect');
  });
});
