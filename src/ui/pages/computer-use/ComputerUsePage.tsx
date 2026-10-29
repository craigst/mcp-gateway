import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { PrimaryButton, SecondaryButton } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { AvailabilityCard } from './AvailabilityCard.js';
import { BrokerCard, ManagedServerCard } from './StatusCards.js';
import { FleetSection } from './FleetSection.js';
import { PauseDialog } from './PauseDialog.js';
import type { PauseDialogValues } from './PauseDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { ToolsCard } from './ToolsCard.js';
import { ActivityCard } from './ActivityCard.js';
import { useLiveData } from './useLiveData.js';
import type {
  ComputerUseAvailability,
  ComputerUseComputerInfo,
  ComputerUseSettingsInput,
} from '../../../core/types.js';

/** Fleet (broker state) poll interval. Frames refresh on their own 3 s tick. */
const FLEET_POLL_MS = 5_000;
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

/**
 * Computer Use console: broker health, the managed MCP server, a live fleet
 * of agent desktops and operator-controlled availability (global and
 * per-computer). Live desktop control itself happens in the broker UI; this
 * page manages access and oversight.
 */
export function ComputerUsePage() {
  const toast = useToast();

  const overview = useLiveData(() => api.getComputerUseOverview(), { intervalMs: OVERVIEW_POLL_MS });
  const fleet = useLiveData(() => api.listComputerUseComputers(), { intervalMs: FLEET_POLL_MS });
  const activity = useLiveData(() => api.getComputerUseActivity(ACTIVITY_LIMIT));

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
  const { refresh: refreshActivity } = activity;
  const refreshAll = (): void => {
    refreshOverview();
    refreshFleet();
    refreshActivity();
  };

  const reloadAvailability = (): void => {
    refreshOverview();
    refreshFleet();
  };

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
    setPauseTarget({ scope: 'global', current: overview.data?.availability ?? null });
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

  const globalAvailability = overview.data?.availability ?? null;
  const globalPaused = globalAvailability?.state === 'paused';
  const refreshing = overview.refreshing || fleet.refreshing || activity.refreshing;

  const pauseScope: 'global' | 'computer' = pauseTarget?.scope ?? 'global';
  const pauseComputerName = pauseTarget !== null && pauseTarget.scope === 'computer' ? pauseTarget.computerName : undefined;
  const pauseCurrent = pauseTarget?.current ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">Computer Use</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Agent desktops proxied through the Computer Broker. Pause computer use globally or per computer —
            the gateway refuses paused calls immediately and never queues them. Live keyboard and mouse
            control happens in the broker&apos;s own desktop UI.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={globalPaused ? 'warning' : 'success'}>
            {globalPaused ? 'agents paused' : 'agents enabled'}
          </Badge>
          <SecondaryButton onClick={refreshAll} disabled={refreshing} className="px-3 py-1.5 text-xs">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </SecondaryButton>
          <PrimaryButton onClick={() => void syncBroker()} disabled={syncing} className="px-3 py-1.5 text-xs">
            {syncing ? 'Syncing…' : 'Sync broker'}
          </PrimaryButton>
        </div>
      </div>

      {actionError !== null && (
        <Notice tone="error" title="Computer use action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}

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

      <div className="grid gap-4 lg:grid-cols-2">
        <BrokerCard
          overview={overview.data}
          loading={overview.loading}
          error={overview.data === null ? overview.error : null}
          onOpenSettings={openSettings}
          onRetry={refreshOverview}
        />
        <ManagedServerCard
          overview={overview.data}
          loading={overview.loading}
          error={overview.data === null ? overview.error : null}
          onRetry={refreshOverview}
        />
      </div>

      <FleetSection
        data={fleet.data}
        loading={fleet.loading}
        error={fleet.error}
        refreshing={fleet.refreshing}
        frameTick={frameTick}
        busyKey={busyComputerId}
        onRefresh={refreshFleet}
        onOpenSettings={openSettings}
        onPause={openComputerPause}
        onEditPause={openComputerEdit}
        onResume={(computer) => void resumeComputer(computer)}
        onStart={(computer) => setConfirmTarget({ action: 'start', computer })}
        onStop={(computer) => setConfirmTarget({ action: 'stop', computer })}
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
    </div>
  );
}
