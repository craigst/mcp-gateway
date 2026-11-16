import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { Card } from '../../components/Card.js';
import { SecondaryButton } from '../../components/Form.js';
import { Notice } from '../../components/States.js';

interface DeviceStatus { id: string; name: string; state: 'online' | 'offline' | 'unknown' }

/** DeviceBridge's MCP tool returns structuredContent.result as JSON text. */
export function parseDeviceBridgeResult(value: unknown): DeviceStatus[] {
  if (typeof value !== 'object' || value === null) throw new Error('DeviceBridge returned an unexpected response.');
  const response = value as { isError?: unknown; structuredContent?: { result?: unknown }; content?: unknown };
  if (response.isError === true) throw new Error('DeviceBridge could not list its devices.');
  let payload: unknown = response.structuredContent?.result;
  if (payload === undefined && Array.isArray(response.content)) {
    payload = response.content.find((item: { type?: string }) => item?.type === 'text')?.text;
  }
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) as unknown; } catch { throw new Error('DeviceBridge returned invalid device data.'); }
  }
  if (typeof payload !== 'object' || payload === null || !('devices' in payload) || !Array.isArray(payload.devices)) {
    throw new Error('DeviceBridge did not return a device list.');
  }
  return payload.devices.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const device = item as Record<string, unknown>;
    const id = typeof device.device_id === 'string' ? device.device_id : '';
    const name = typeof device.name === 'string' && device.name ? device.name : typeof device.display === 'string' ? device.display : id;
    if (!id || !name) return [];
    const state = device.online === true ? 'online' : device.online === false ? 'offline' : 'unknown';
    return [{ id, name, state }];
  });
}

export function DeviceBridgeStatus({ onOpenServer }: { onOpenServer?: (id: string) => void }) {
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const servers = await api.listServers();
      const server = servers.find((item) => item.name.toLowerCase() === 'devicebridge');
      if (!server) throw new Error('No DeviceBridge server is registered.');
      setServerId(server.id);
      const result = await api.rpc<unknown>('tools/call', { serverId: server.id, name: 'device_list', arguments: {} });
      setDevices(parseDeviceBridgeResult(result));
    } catch (cause) { setDevices(null); setError(formatApiError(cause)); }
    finally { setBusy(false); }
  };
  return <Card title="DeviceBridge devices" subtitle="A separate inventory; a machine may also appear in the computer broker." actions={<SecondaryButton onClick={() => void load()} disabled={busy} className="px-2 py-1 text-xs">{busy ? 'Loading…' : devices === null ? 'Load devices' : 'Refresh devices'}</SecondaryButton>}>
    {error && <Notice tone="error" title="DeviceBridge unavailable">{error}</Notice>}
    {!error && devices === null && <p className="text-xs text-slate-400">Load the DeviceBridge inventory to see reported names and online status.</p>}
    {devices !== null && (devices.length === 0 ? <p className="text-xs text-slate-400">No devices reported.</p> : <ul className="flex flex-wrap gap-2">{devices.map((device) => <li key={device.id} className="flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-xs text-slate-200"><span>{device.name}</span><Badge tone={device.state === 'online' ? 'success' : 'neutral'}>{device.state}</Badge></li>)}</ul>)}
    {serverId && onOpenServer && <button type="button" className="mt-3 text-xs font-semibold text-sky-300" onClick={() => onOpenServer(serverId)}>Manage DeviceBridge server →</button>}
  </Card>;
}
