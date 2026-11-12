import { useCallback, useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { CheckboxField, PrimaryButton, SecondaryButton } from '../../components/Form.js';
import { Tabs, TabPanel } from '../../components/Tabs.js';
import { useToast } from '../../components/Toasts.js';
import { useLiveData } from '../computer-use/useLiveData.js';
import { AvailabilityCard } from '../computer-use/AvailabilityCard.js';
import { BrokerCard, ManagedServerCard } from '../computer-use/StatusCards.js';
import { FleetSection } from '../computer-use/FleetSection.js';
import { ToolsCard } from '../computer-use/ToolsCard.js';
import { ActivityCard } from '../computer-use/ActivityCard.js';
import { PauseDialog } from '../computer-use/PauseDialog.js';
import type { PauseDialogValues } from '../computer-use/PauseDialog.js';
import { SettingsDialog } from '../computer-use/SettingsDialog.js';
import { isComputerRunning } from '../computer-use/shared.js';
import { DevicesSection } from '../connectors/DevicesSection.js';
import { PendingPairingsSection } from '../connectors/PendingPairingsSection.js';
import { AddLinuxPcDialog } from '../connectors/AddLinuxPcDialog.js';
import { AddHostComputerDialog } from '../connectors/AddHostComputerDialog.js';
import { TerminalDialog } from '../connectors/TerminalDialog.js';
import { VmProvidersSection } from '../connectors/VmProvidersSection.js';
import {
  enrollmentExpiryLabel,
  enrollmentKindLabel,
  pairingBlockedReason,
} from '../connectors/shared.js';
import { formatTimestamp } from '../../lib/format.js';
import { DEFAULT_DEVICES_TAB, DEVICES_TABS } from './tabs.js';
import type { DevicesTab } from './tabs.js';
import type {
  ComputerUseAvailability,
  ComputerUseComputerInfo,
  ComputerUseDeviceInfo,
  ComputerUseEnrollmentInfo,
  ComputerUseSettingsInput,
} from '../../../core/types.js';

/** Fleet (broker computers) poll interval. Frames refresh on their own 3 s tick. */
const FLEET_POLL_MS = 5_000;
/** Connector/device snapshot poll interval (pending pairings + device state). */
const CONNECTORS_POLL_MS = 5_000;
/** Slow overview poll so an auto-expiring pause and managed-server state stay current. */
const OVERVIEW_POLL_MS = 15_000;
/** Live frame refresh interval; paused while the tab is hidden. */
const FRAME_INTERVAL_MS = 3_000;
const ACTIVITY_LIMIT = 50;

type PauseTarget =
  | { scope: 'global'; current: ComputerUseAvailability | null }
  | {
      scope: 'computer';
      computerId: string;
      computerName: string;
      current: ComputerUseAvailability | null;
    };

interface ConfirmTarget {
  action: 'start' | 'stop';
  computer: ComputerUseComputerInfo;
}

export interface DevicesPageProps {
  /** Deep-link target (`#/devices?tab=…`); defaults to Computers. */
  initialTab?: DevicesTab;
  onTabChange?: (tab: DevicesTab) => void;
}

/**
 * Devices & computers — the single console surface for the Computer Broker
 * fleet, its connectors and the agent-facing MCP server.
 *
 * Merges the former "Computer Use" and "Connectors" pages:
 * - **Computers** — global availability, broker health, and one grid of every
 *   broker computer (host PCs with live system stats and connector
 *   maintenance, VMs and agent desktops with frames and start/stop).
 * - **Connectors** — Linux PC onboarding, pending pairings, device connectors
 *   and the proxied interactive terminal.
 * - **VM providers** — KVM/QEMU hosts and the VMs deployed on them.
 * - **Agent access** — the managed `computer-use` MCP server, its tools and
 *   recent audit activity.
 */
export function DevicesPage({ initialTab = DEFAULT_DEVICES_TAB, onTabChange }: DevicesPageProps) {
  const toast = useToast();

  const overview = useLiveData(() => api.getComputerUseOverview(), { intervalMs: OVERVIEW_POLL_MS });
  const fleet = useLiveData(() => api.listComputerUseComputers(), { intervalMs: FLEET_POLL_MS });
  const connectors = useLiveData(() => api.getComputerUseConnectors(), { intervalMs: CONNECTORS_POLL_MS });
  const activity = useLiveData(() => api.getComputerUseActivity(ACTIVITY_LIMIT));

  const [tab, setTabState] = useState<DevicesTab>(initialTab);
  const [frameTick, setFrameTick] = useState(0);

  const [pauseTarget, setPauseTarget] = useState<PauseTarget | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [busyComputerId, setBusyComputerId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Linux PC pairing (Connectors tab).
  const [addOpen, setAddOpen] = useState(false);
  const [addBaseline, setAddBaseline] = useState<string[]>([]);
  const [terminalDevice, setTerminalDevice] = useState<ComputerUseDeviceInfo | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ComputerUseEnrollmentInfo | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  // Physical host onboarding + connector maintenance (Computers tab).
  const [addHostOpen, setAddHostOpen] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<ComputerUseComputerInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<{
    name: string;
    version: string | null;
    previousVersion: string | null;
  } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ComputerUseComputerInfo | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeComputer, setRemoveComputer] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Keep the active tab in sync with deep links (`#/devices?tab=connectors`).
  useEffect(() => {
    setTabState(initialTab);
  }, [initialTab]);

  const setTab = useCallback(
    (next: DevicesTab) => {
      setTabState(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );

  // Refresh previews only while the document is visible; refresh once on return.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setFrameTick((tick) => tick + 1);
    }, FRAME_INTERVAL_MS);
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        setFrameTick((tick) => tick + 1);
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const { refresh: refreshOverview } = overview;
  const { refresh: refreshFleet } = fleet;
  const { refresh: refreshConnectors } = connectors;
  const { refresh: refreshActivity } = activity;
  const refreshAll = (): void => {
    refreshOverview();
    refreshFleet();
    refreshConnectors();
    refreshActivity();
  };

  const reloadAvailability = (): void => {
    refreshOverview();
    refreshFleet();
  };

  const computers = fleet.data?.computers ?? [];
  const devices = connectors.data?.devices ?? [];
  const enrollments = connectors.data?.enrollments ?? [];
  const onlineCount = computers.filter((computer) => isComputerRunning(computer.state)).length;
  const pendingCount = connectors.data?.counts.pendingEnrollments ?? 0;
  const pairingBlocked = pairingBlockedReason(connectors.data);
  const globalAvailability = overview.data?.availability ?? null;
  const globalPaused = globalAvailability?.state === 'paused';
  const refreshing = overview.refreshing || fleet.refreshing || connectors.refreshing || activity.refreshing;

  // -- availability ---------------------------------------------------------

  const closePauseDialog = (): void => {
    if (pauseBusy) return;
    setPauseTarget(null);
    setPauseError(null);
  };

  const openGlobalPause = (): void => {
    setPauseError(null);
    setPauseTarget({ scope: 'global', current: null });
  };

  const openGlobalEdit = (): void => {
    setPauseError(null);
    setPauseTarget({ scope: 'global', current: globalAvailability });
  };

  const openComputerPause = (computer: ComputerUseComputerInfo): void => {
    setPauseError(null);
    setPauseTarget({
      scope: 'computer',
      computerId: computer.id,
      computerName: computer.name,
      current: null,
    });
  };

  const openComputerEdit = (computer: ComputerUseComputerInfo): void => {
    setPauseError(null);
    setPauseTarget({
      scope: 'computer',
      computerId: computer.id,
      computerName: computer.name,
      current: computer.availability,
    });
  };

  const submitPause = async (values: PauseDialogValues): Promise<void> => {
    if (pauseTarget === null) return;
    setPauseBusy(true);
    setPauseError(null);
    try {
      if (pauseTarget.scope === 'global') {
        await api.setComputerUseAvailability({
          scope: 'global',
          available: false,
          reason: values.reason,
          until: values.until,
        });
        toast('success', 'Computer use paused for every agent.');
      } else {
        await api.setComputerUseAvailability({
          scope: 'computer',
          computerId: pauseTarget.computerId,
          available: false,
          reason: values.reason,
          until: values.until,
        });
        toast('success', `${pauseTarget.computerName} paused for agents.`);
      }
      setPauseTarget(null);
      reloadAvailability();
    } catch (error) {
      setPauseError(formatApiError(error));
    } finally {
      setPauseBusy(false);
    }
  };

  const resumeGlobal = async (): Promise<void> => {
    setAvailabilityBusy(true);
    setActionError(null);
    try {
      await api.setComputerUseAvailability({ scope: 'global', available: true });
      toast('success', 'Computer use resumed for every agent.');
      reloadAvailability();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setAvailabilityBusy(false);
    }
  };

  const resumeComputer = async (computer: ComputerUseComputerInfo): Promise<void> => {
    setBusyComputerId(computer.id);
    try {
      await api.setComputerUseAvailability({
        scope: 'computer',
        computerId: computer.id,
        available: true,
      });
      toast('success', `${computer.name} resumed for agents.`);
      reloadAvailability();
    } catch (error) {
      toast('error', formatApiError(error));
    } finally {
      setBusyComputerId(null);
    }
  };

  const runConfirmedAction = async (): Promise<void> => {
    if (confirmTarget === null) return;
    const { action, computer } = confirmTarget;
    setConfirmBusy(true);
    try {
      const updated =
        action === 'start'
          ? await api.startComputerUseComputer(computer.id)
          : await api.stopComputerUseComputer(computer.id);
      toast('success', `${updated.name} ${action === 'start' ? 'started' : 'stopped'}.`);
      setConfirmTarget(null);
      refreshAll();
    } catch (error) {
      toast('error', formatApiError(error));
    } finally {
      setConfirmBusy(false);
    }
  };

  const syncBroker = async (): Promise<void> => {
    setSyncing(true);
    setActionError(null);
    try {
      const next = await api.syncComputerUse();
      if (next.broker.reachable) {
        toast('success', 'Broker reconnected — managed server and tools refreshed.');
      } else {
        toast('info', 'Sync finished, but the broker is still unreachable. Check the URL and token.');
      }
      refreshAll();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setSyncing(false);
    }
  };

  // -- broker settings ------------------------------------------------------

  const openSettings = (): void => {
    setSettingsError(null);
    setSettingsOpen(true);
  };

  const closeSettings = (): void => {
    if (settingsBusy) return;
    setSettingsOpen(false);
    setSettingsError(null);
  };

  const submitSettings = async (input: ComputerUseSettingsInput): Promise<void> => {
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      await api.updateComputerUseSettings(input);
      toast('success', 'Computer use settings saved.');
      setSettingsOpen(false);
      refreshAll();
    } catch (error) {
      setSettingsError(formatApiError(error));
    } finally {
      setSettingsBusy(false);
    }
  };

  // -- connectors -----------------------------------------------------------

  const openAddDialog = (): void => {
    if (pairingBlocked !== null) return;
    setAddBaseline(devices.map((device) => device.id));
    setAddOpen(true);
  };

  const handleConnected = useCallback(
    (device: { id: string; name: string }) => {
      toast('success', `${device.name} connected to the broker — pairing claimed.`);
      setAddOpen(false);
      refreshConnectors();
      refreshFleet();
    },
    [toast, refreshConnectors, refreshFleet],
  );

  const confirmRevoke = async (): Promise<void> => {
    if (revokeTarget === null) return;
    setRevokeBusy(true);
    setActionError(null);
    try {
      await api.revokeComputerUseEnrollment(revokeTarget.id);
      toast('success', 'Pairing token revoked.');
      setRevokeTarget(null);
      refreshConnectors();
    } catch (revokeError) {
      const message = formatApiError(revokeError);
      setActionError(message);
      toast('error', message);
      setRevokeTarget(null);
    } finally {
      setRevokeBusy(false);
    }
  };

  // -- host connector maintenance ------------------------------------------

  const openUpdate = (computer: ComputerUseComputerInfo): void => {
    setUpdateError(null);
    setUpdateTarget(computer);
  };

  const confirmUpdate = async (): Promise<void> => {
    if (updateTarget === null) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const result = await api.updateComputerUseConnector(updateTarget.id);
      setLastUpdate({
        name: updateTarget.name,
        version: result.version,
        previousVersion: result.connectorVersion,
      });
      toast(
        'success',
        result.version !== null
          ? `Connector on ${updateTarget.name} updated to v${result.version}.`
          : `Connector on ${updateTarget.name} updated.`,
      );
      setUpdateTarget(null);
      refreshFleet();
    } catch (error) {
      setUpdateError(formatApiError(error));
    } finally {
      setUpdateBusy(false);
    }
  };

  const openRemove = (computer: ComputerUseComputerInfo): void => {
    setRemoveError(null);
    setRemoveComputer(false);
    setRemoveTarget(computer);
  };

  const confirmRemove = async (): Promise<void> => {
    if (removeTarget === null) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const result = await api.removeComputerUseConnector(removeTarget.id, { removeComputer });
      toast(
        'success',
        result.computerRemoved
          ? `${removeTarget.name} and its connector were removed.`
          : `Connector removed from ${removeTarget.name}.`,
      );
      setRemoveTarget(null);
      setRemoveComputer(false);
      refreshFleet();
    } catch (error) {
      setRemoveError(formatApiError(error));
    } finally {
      setRemoveBusy(false);
    }
  };

  // -- render ---------------------------------------------------------------

  const pauseScope: 'global' | 'computer' = pauseTarget?.scope ?? 'global';
  const pauseComputerName =
    pauseTarget !== null && pauseTarget.scope === 'computer' ? pauseTarget.computerName : undefined;
  const pauseCurrent = pauseTarget?.current ?? null;
  const tabItems = DEVICES_TABS.map((item) => ({
    ...item,
    badge:
      item.key === 'connectors' && pendingCount > 0
        ? pendingCount
        : item.key === 'computers' && computers.length > 0
          ? computers.length
          : undefined,
  }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">Devices &amp; computers</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            One place for the Computer Broker estate: computers (host PCs, VMs and agent desktops),
            the connectors that enrol them, VM providers, and the managed MCP server agents call.
            Live keyboard and mouse control still happens in the broker&apos;s own desktop UI.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={globalPaused ? 'warning' : 'success'}>
            {globalPaused ? 'agents paused' : 'agents enabled'}
          </Badge>
          {computers.length > 0 && (
            <Badge tone={onlineCount > 0 ? 'info' : 'neutral'}>{onlineCount} online</Badge>
          )}
          {pendingCount > 0 && <Badge tone="info">{pendingCount} pending</Badge>}
          <SecondaryButton onClick={refreshAll} disabled={refreshing} className="px-3 py-1.5 text-xs">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </SecondaryButton>
          <PrimaryButton onClick={() => void syncBroker()} disabled={syncing} className="px-3 py-1.5 text-xs">
            {syncing ? 'Syncing…' : 'Sync broker'}
          </PrimaryButton>
          <SecondaryButton onClick={openSettings} className="px-3 py-1.5 text-xs">
            Broker settings
          </SecondaryButton>
        </div>
      </div>

      {actionError !== null && (
        <Notice tone="error" title="Devices action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

      <Tabs items={tabItems} active={tab} onChange={setTab} label="Devices & computers sections" />

      <TabPanel id="computers" active={tab === 'computers'} className="space-y-5">
        <AvailabilityCard
          overview={overview.data}
          loading={overview.loading}
          error={overview.data === null ? overview.error : null}
          busy={availabilityBusy}
          onPause={openGlobalPause}
          onEditPause={openGlobalEdit}
          onResume={() => void resumeGlobal()}
          onRetry={refreshOverview}
        />

        <BrokerCard
          overview={overview.data}
          loading={overview.loading}
          error={overview.data === null ? overview.error : null}
          onOpenSettings={openSettings}
          onRetry={refreshOverview}
        />

        {lastUpdate !== null && (
          <Notice tone="success" title="Connector updated" onDismiss={() => setLastUpdate(null)}>
            {lastUpdate.name} is now running connector{' '}
            {lastUpdate.version !== null ? `v${lastUpdate.version}` : 'an updated build'}
            {lastUpdate.previousVersion !== null && lastUpdate.previousVersion !== ''
              ? ` (was v${lastUpdate.previousVersion})`
              : ''}
            . The connector reconnects automatically.
          </Notice>
        )}

        <FleetSection
          data={fleet.data}
          loading={fleet.loading}
          error={fleet.error}
          refreshing={fleet.refreshing}
          frameTick={frameTick}
          busyKey={busyComputerId}
          connectorBusyId={updateBusy ? (updateTarget?.id ?? null) : removeBusy ? (removeTarget?.id ?? null) : null}
          onRefresh={refreshFleet}
          onOpenSettings={openSettings}
          onPause={openComputerPause}
          onEditPause={openComputerEdit}
          onResume={(computer) => void resumeComputer(computer)}
          onStart={(computer) => setConfirmTarget({ action: 'start', computer })}
          onStop={(computer) => setConfirmTarget({ action: 'stop', computer })}
          onUpdateConnector={openUpdate}
          onRemoveConnector={openRemove}
          headerActions={
            <PrimaryButton onClick={() => setAddHostOpen(true)} className="px-3 py-1.5 text-xs">
              Add physical computer
            </PrimaryButton>
          }
        />
      </TabPanel>

      <TabPanel id="connectors" active={tab === 'connectors'} className="space-y-5">
        <section aria-labelledby="connector-onboarding-heading" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <h2 id="connector-onboarding-heading" className="text-base font-semibold text-slate-100">
                Connectors
              </h2>
              <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
                Onboard Linux PCs as Computer Broker connectors. Each pairing mints a single-use
                install command — the machine claims it by dialling out to the broker. Interactive
                terminals are opt-in per pairing.
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Public broker URL:{' '}
                {connectors.data?.publicBrokerUrl != null ? (
                  <span className="font-mono text-slate-300">{connectors.data.publicBrokerUrl}</span>
                ) : (
                  <span className="text-amber-300/90">not set — pairing is blocked</span>
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {pendingCount > 0 && <Badge tone="info">{pendingCount} pending</Badge>}
              <SecondaryButton
                onClick={refreshConnectors}
                disabled={connectors.refreshing}
                className="px-3 py-1.5 text-xs"
              >
                {connectors.refreshing ? 'Refreshing…' : 'Refresh connectors'}
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
          {pairingBlocked !== null && connectors.data !== null && (
            <p className="text-[11px] text-amber-300/80" role="note">
              {pairingBlocked}
            </p>
          )}
        </section>

        <PendingPairingsSection
          enrollments={enrollments}
          loading={connectors.loading && connectors.data === null}
          onRevoke={(enrollment) => setRevokeTarget(enrollment)}
        />

        <DevicesSection
          devices={devices}
          loading={connectors.loading}
          error={connectors.error}
          publicBrokerUrl={connectors.data?.publicBrokerUrl ?? null}
          brokerReachable={connectors.data?.broker.reachable === true}
          brokerError={connectors.data?.broker.error ?? null}
          pairingBlockedReason={pairingBlocked}
          refreshing={connectors.refreshing}
          onTerminal={(device) => setTerminalDevice(device)}
          onAdd={openAddDialog}
          onRefresh={refreshConnectors}
        />
      </TabPanel>

      <TabPanel id="providers" active={tab === 'providers'}>
        <VmProvidersSection
          computers={computers}
          onRefreshComputers={refreshFleet}
          onShowComputers={() => setTab('computers')}
        />
      </TabPanel>

      <TabPanel id="access" active={tab === 'access'} className="space-y-5">
        <ManagedServerCard
          overview={overview.data}
          loading={overview.loading}
          error={overview.data === null ? overview.error : null}
          onRetry={refreshOverview}
        />
        <ToolsCard
          tools={overview.data?.tools ?? []}
          loading={overview.loading && overview.data === null}
          error={overview.data === null ? overview.error : null}
          onRetry={refreshOverview}
        />
        <ActivityCard
          entries={activity.data ?? []}
          loading={activity.loading && activity.data === null}
          error={activity.data === null ? activity.error : null}
          onRefresh={refreshActivity}
        />
      </TabPanel>

      <PauseDialog
        open={pauseTarget !== null}
        scope={pauseScope}
        computerName={pauseComputerName}
        current={pauseCurrent}
        busy={pauseBusy}
        error={pauseError}
        onCancel={closePauseDialog}
        onSubmit={(values) => void submitPause(values)}
      />

      <SettingsDialog
        open={settingsOpen}
        info={overview.data?.settings ?? null}
        busy={settingsBusy}
        error={settingsError}
        onCancel={closeSettings}
        onSubmit={(input) => void submitSettings(input)}
      />

      <ConfirmDialog
        open={confirmTarget !== null}
        title={
          confirmTarget === null
            ? 'Computer action'
            : `${confirmTarget.action === 'start' ? 'Start' : 'Stop'} ${confirmTarget.computer.name}`
        }
        tone={confirmTarget?.action === 'stop' ? 'danger' : 'default'}
        confirmLabel={confirmTarget?.action === 'stop' ? 'Stop desktop' : 'Start desktop'}
        busy={confirmBusy}
        onConfirm={() => void runConfirmedAction()}
        onCancel={() => {
          if (!confirmBusy) setConfirmTarget(null);
        }}
        description={
          confirmTarget?.action === 'start'
            ? 'Starting the desktop makes it available to permitted agents (unless availability is paused). It keeps running until stopped or its TTL expires.'
            : 'Stopping the desktop ends any active broker session. Agents cannot use it until it is started again.'
        }
      />

      <AddHostComputerDialog
        open={addHostOpen}
        onClose={() => setAddHostOpen(false)}
        onCreated={refreshFleet}
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

      <ConfirmDialog
        open={updateTarget !== null}
        title={updateTarget === null ? 'Update connector' : `Update connector on ${updateTarget.name}`}
        description="The broker pushes its current connector bundle, swaps it in and restarts the connector service. The PC stays usable; live desktop may drop for a few seconds."
        confirmLabel="Update connector"
        cancelLabel="Cancel"
        busy={updateBusy}
        onConfirm={() => void confirmUpdate()}
        onCancel={() => {
          if (!updateBusy) setUpdateTarget(null);
        }}
      >
        <div className="space-y-2 text-xs text-slate-400">
          {updateTarget?.connector?.version != null && (
            <p>
              Currently running connector v{updateTarget.connector.version}. A successful update is
              shown here and on the card as the new version.
            </p>
          )}
          {updateError !== null && (
            <Notice tone="error" title="Connector update failed" onDismiss={() => setUpdateError(null)}>
              {updateError}
            </Notice>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={removeTarget !== null}
        title={removeTarget === null ? 'Remove connector' : `Remove connector from ${removeTarget.name}`}
        tone="danger"
        confirmLabel="Remove connector"
        cancelLabel="Cancel"
        busy={removeBusy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => {
          if (!removeBusy) setRemoveTarget(null);
        }}
      >
        <div className="space-y-3 text-xs text-slate-400">
          <p>
            This disables and removes the connector on the PC and deletes its identity, so it can no
            longer reconnect. The machine is not affected otherwise.
          </p>
          <CheckboxField
            label={
              <span>
                Also remove this computer from the fleet
                <span className="block text-[11px] text-slate-500">
                  Drops its history, desktop and stats. Leave unchecked to keep the computer listed
                  without a connector.
                </span>
              </span>
            }
            checked={removeComputer}
            onChange={setRemoveComputer}
            disabled={removeBusy}
          />
          {removeError !== null && (
            <Notice tone="error" title="Connector removal failed" onDismiss={() => setRemoveError(null)}>
              {removeError}
            </Notice>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
