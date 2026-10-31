import { useCallback, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { PrimaryButton, SecondaryButton } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { formatTimestamp } from '../../lib/format.js';
import { useLiveData } from '../computer-use/useLiveData.js';
import { AddLinuxPcDialog } from './AddLinuxPcDialog.js';
import { BrokerStatusCard } from './BrokerStatusCard.js';
import { DevicesSection } from './DevicesSection.js';
import { PendingPairingsSection } from './PendingPairingsSection.js';
import { PhysicalComputersSection } from './PhysicalComputersSection.js';
import { TerminalDialog } from './TerminalDialog.js';
import {
  enrollmentKindLabel,
  enrollmentExpiryLabel,
  pairingBlockedReason,
} from './shared.js';
import type {
  ComputerUseDeviceInfo,
  ComputerUseEnrollmentInfo,
} from '../../../core/types.js';

/** Connector/device snapshot poll interval (pending + device state). */
const CONNECTORS_POLL_MS = 5_000;

/**
 * Connectors console (v0.10): onboard Linux PCs as Computer Broker connectors.
 * Mint a single-use install command, watch the pending pairing claim itself,
 * revoke tokens, and open an interactive terminal on a capable connector.
 * Everything is proxied through the broker — the console never dials a PC.
 */
export function ConnectorsPage() {
  const toast = useToast();
  const connectors = useLiveData(() => api.getComputerUseConnectors(), {
    intervalMs: CONNECTORS_POLL_MS,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [addBaseline, setAddBaseline] = useState<string[]>([]);
  const [terminalDevice, setTerminalDevice] = useState<ComputerUseDeviceInfo | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ComputerUseEnrollmentInfo | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { refresh } = connectors;
  const data = connectors.data;
  const devices = data?.devices ?? [];
  const enrollments = data?.enrollments ?? [];
  const onlineCount = data?.counts.online ?? 0;
  const pendingCount = data?.counts.pendingEnrollments ?? 0;
  const pairingBlocked = pairingBlockedReason(data);
  const refreshing = connectors.refreshing;

  const handleRefresh = (): void => {
    setActionError(null);
    refresh();
  };

  const openAddDialog = (): void => {
    if (pairingBlocked !== null) return;
    setAddBaseline(devices.map((device) => device.id));
    setAddOpen(true);
  };

  const handleConnected = useCallback(
    (device: { id: string; name: string }) => {
      toast('success', `${device.name} connected to the broker — pairing claimed.`);
      setAddOpen(false);
      refresh();
    },
    [toast, refresh],
  );

  const confirmRevoke = async (): Promise<void> => {
    if (revokeTarget === null) return;
    setRevokeBusy(true);
    setActionError(null);
    try {
      await api.revokeComputerUseEnrollment(revokeTarget.id);
      toast('success', 'Pairing token revoked.');
      setRevokeTarget(null);
      refresh();
    } catch (revokeError) {
      const message = formatApiError(revokeError);
      setActionError(message);
      toast('error', message);
      setRevokeTarget(null);
    } finally {
      setRevokeBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">Connectors</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Onboard Linux PCs as Computer Broker connectors. Each pairing mints a single-use install
            command — the machine claims it by dialling out to the broker. Interactive terminals are
            opt-in per pairing and give this console a real shell on the machine.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data !== null && (
            <Badge tone={onlineCount > 0 ? 'success' : 'neutral'}>
              {onlineCount} online
            </Badge>
          )}
          {pendingCount > 0 && <Badge tone="info">{pendingCount} pending</Badge>}
          <SecondaryButton onClick={handleRefresh} disabled={refreshing} className="px-3 py-1.5 text-xs">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </SecondaryButton>
          <span title={pairingBlocked ?? undefined} className="inline-flex">
            <PrimaryButton
              onClick={openAddDialog}
              disabled={pairingBlocked !== null}
              className="px-3 py-1.5 text-xs"
            >
              Add Linux PC
            </PrimaryButton>
          </span>
        </div>
      </div>

      {pairingBlocked !== null && data !== null && (
        <p className="text-[11px] text-amber-300/80" role="note">
          {pairingBlocked}
        </p>
      )}

      {actionError !== null && (
        <Notice tone="error" title="Connector action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      <BrokerStatusCard
        data={data}
        loading={connectors.loading}
        error={connectors.error}
        onRetry={refresh}
      />

      <PhysicalComputersSection />

      <PendingPairingsSection
        enrollments={enrollments}
        loading={connectors.loading && data === null}
        onRevoke={(enrollment) => setRevokeTarget(enrollment)}
      />

      <DevicesSection
        devices={devices}
        loading={connectors.loading}
        error={connectors.error}
        publicBrokerUrl={data?.publicBrokerUrl ?? null}
        brokerReachable={data?.broker.reachable === true}
        brokerError={data?.broker.error ?? null}
        pairingBlockedReason={pairingBlocked}
        refreshing={refreshing}
        onTerminal={(device) => setTerminalDevice(device)}
        onAdd={openAddDialog}
        onRefresh={refresh}
      />

      <AddLinuxPcDialog
        open={addOpen}
        initialDeviceIds={addBaseline}
        onClose={() => setAddOpen(false)}
        onConnected={handleConnected}
      />

      <TerminalDialog device={terminalDevice} onClose={() => setTerminalDevice(null)} />

      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget === null ? 'Revoke pairing' : `Revoke pairing ${revokeTarget.id}`}
        tone="danger"
        confirmLabel="Revoke pairing"
        busy={revokeBusy}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => {
          if (!revokeBusy) setRevokeTarget(null);
        }}
        description="The token stops working immediately. A machine that has not claimed it yet will be refused."
      >
        {revokeTarget !== null && (
          <p className="text-xs text-slate-400">
            {enrollmentKindLabel(revokeTarget.kind)} pairing · created{' '}
            {formatTimestamp(revokeTarget.createdAt)} · expires{' '}
            {enrollmentExpiryLabel(revokeTarget)} ({formatTimestamp(revokeTarget.expiresAt)}).
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
