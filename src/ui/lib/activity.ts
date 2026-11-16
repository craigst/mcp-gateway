import type { AuditEntry, KeySummary, ServerRecord } from '../../core/types.js';

/** Format the common OpenMausBot key naming convention for display only. */
export function clientLabel(name: string): string {
  const match = /^omb-([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(name);
  if (!match) return name;
  const friendly = match[1]!.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return `${friendly} · ${name}`;
}

/** Show configured names without guessing which bot owns a key. */
export function activityClient(entry: AuditEntry, keys: readonly KeySummary[]): string {
  if (!entry.keyId) return 'Unidentified client';
  const key = keys.find((item) => item.id === entry.keyId);
  return key ? clientLabel(key.name) : `Unknown key (${entry.keyId})`;
}

export function activityServer(entry: AuditEntry, servers: readonly ServerRecord[]): string | null {
  if (!entry.serverId) return null;
  return servers.find((server) => server.id === entry.serverId)?.name ?? `Unknown server (${entry.serverId})`;
}

/** Translate common protocol operations while retaining the exact method in detail views. */
export function activityAction(entry: AuditEntry): string {
  if (entry.method === 'tools/call') return entry.toolId ? `${entry.status === 'ok' ? 'Used' : 'Attempted'} ${entry.toolId}` : 'Called a tool';
  const labels: Record<string, string> = {
    initialize: entry.status === 'ok' ? 'Connected to the gateway' : 'Attempted to connect',
    'tools/list': entry.status === 'ok' ? 'Listed available tools' : 'Requested the tool list',
    'tools/search': 'Searched available tools',
    'servers/list_permitted': 'Listed permitted servers',
    'resources/list': 'Listed resources',
    'prompts/list': 'Listed prompts',
  };
  return labels[entry.method] ?? entry.method;
}
