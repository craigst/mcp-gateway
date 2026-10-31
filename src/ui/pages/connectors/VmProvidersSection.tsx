import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Badge } from '../../components/Badge.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice, ErrorState } from '../../components/States.js';
import { EmptyState } from '../../components/EmptyState.js';
import { SkeletonCards } from '../../components/Skeleton.js';
import { PrimaryButton, SecondaryButton, DangerButton } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { useLiveData } from '../computer-use/useLiveData.js';
import { computerStateTone, connectorTone } from '../computer-use/shared.js';
import { AddVmProviderDialog } from './AddVmProviderDialog.js';
import { DeployVmDialog } from './DeployVmDialog.js';
import {
  formatMemoryMb,
  formatTestDetails,
  isVmRunning,
  isVmStarting,
  providerBaseImage,
  providerDefaults,
  providerEndpoint,
  providerNetwork,
  providerStateTone,
  providerStorageDir,
  vmHostIdOf,
  vmResourcesSummary,
} from './vmShared.js';
import type { ComputerUseComputerInfo, ComputerUseVmHostInfo } from '../../../core/types.js';

/** Provider registry poll interval (registrations change rarely). */
const PROVIDERS_POLL_MS = 15_000;
/** VM fleet poll interval. */
const VMS_POLL_MS = 5_000;

interface ProviderTestState {
  ok: boolean | null;
  details: string;
}

function VmRow({
  vm,
  providerName,
}: {
  vm: ComputerUseComputerInfo;
  providerName: string | null;
}) {
  const resources = vmResourcesSummary(vm);
  return (
    <li className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5">
      <span className="truncate text-xs font-medium text-slate-200" title={vm.name}>
        {vm.name}
      </span>
      {providerName !== null && <Badge tone="info">{providerName}</Badge>}
      <Badge tone={computerStateTone(vm.state)}>{vm.state}</Badge>
      {vm.connector !== null && (
        <Badge tone={connectorTone(vm.connector.state)}>connector {vm.connector.state}</Badge>
      )}
      {resources !== null && <span className="text-[10px] text-slate-500">{resources}</span>}
      <a
        href={api.computerUseLiveDesktopUrl(vm.id)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open live desktop for ${vm.name}`}
        className="ml-auto text-[11px] font-semibold text-sky-300 underline decoration-sky-800 underline-offset-2 hover:text-sky-200"
      >
        Open live desktop ↗
      </a>
    </li>
  );
}

interface ProviderCardProps {
  host: ComputerUseVmHostInfo;
  vms: ComputerUseComputerInfo[];
  test: ProviderTestState | null;
  testing: boolean;
  busy: boolean;
  onTest: (host: ComputerUseVmHostInfo) => void;
  onDeploy: (host: ComputerUseVmHostInfo) => void;
  onDelete: (host: ComputerUseVmHostInfo) => void;
}

function VmProviderCard({ host, vms, test, testing, busy, onTest, onDeploy, onDelete }: ProviderCardProps) {
  const defaults = providerDefaults(host);
  const endpoint = providerEndpoint(host);
  const baseImage = providerBaseImage(host);
  const storageDir = providerStorageDir(host);
  const network = providerNetwork(host);
  const total = vms.length;
  const running = vms.filter((vm) => isVmRunning(vm.state)).length;
  const baseReady = host.baseReady === true;
  const deleteBlocked = total > 0;
  const deleteBlockedReason = deleteBlocked
    ? `${total} VM${total === 1 ? '' : 's'} reference this provider — delete or move them first.`
    : null;
  const deployBlockedReason = !baseReady
    ? 'Base image is not ready — test the provider (or fix lastError) before deploying VMs.'
    : null;

  return (
    <article
      aria-label={`VM provider ${host.name}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg shadow-black/20"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100" title={host.name}>
            {host.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <Badge tone="accent">{host.kind}</Badge>
            <Badge tone={providerStateTone(host.state)}>{host.state}</Badge>
            <Badge tone={baseReady ? 'success' : 'warning'}>
              {baseReady ? 'base image ready' : 'base image missing'}
            </Badge>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone="info">
            {total} VM{total === 1 ? '' : 's'}
          </Badge>
          <Badge tone={running > 0 ? 'success' : 'neutral'}>
            {running} running
          </Badge>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
        <div className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Endpoint</dt>
          <dd className="truncate text-[11px] text-slate-300" title={endpoint ?? undefined}>
            {endpoint ?? '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Defaults</dt>
          <dd className="text-[11px] text-slate-300">
            {defaults.vcpus} vCPU · {formatMemoryMb(defaults.memoryMb)} RAM · {defaults.diskGb} GB disk
          </dd>
        </div>
        <div className="min-w-0 col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Base image</dt>
          <dd className="truncate font-mono text-[10px] text-slate-400" title={baseImage ?? undefined}>
            {baseImage ?? 'not set'}
          </dd>
        </div>
        <div className="min-w-0 col-span-2">
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Storage</dt>
          <dd className="truncate font-mono text-[10px] text-slate-400" title={storageDir ?? undefined}>
            {storageDir ?? 'not set'}
            {network !== null ? ` · network ${network}` : ''}
          </dd>
        </div>
      </dl>

      {host.lastError !== null && host.lastError.trim() !== '' && (
        <Notice tone="error" title="Provider error">
          {host.lastError}
        </Notice>
      )}

      {test !== null && (
        <div className="space-y-1">
          <Notice
            tone={test.ok === true ? 'success' : test.ok === false ? 'error' : 'info'}
            title={
              test.ok === true
                ? 'Provider test passed'
                : test.ok === false
                  ? 'Provider test failed'
                  : 'Provider test result'
            }
          >
            {test.ok === true
              ? 'SSH/base image/storage/KVM checks passed.'
              : test.ok === false
                ? 'See the details below, fix the provider and test again.'
                : 'Test finished; see details below.'}
          </Notice>
          {test.details !== '' && (
            <pre
              aria-label={`Test details for ${host.name}`}
              className="max-h-40 overflow-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-[10px] leading-relaxed text-slate-300 whitespace-pre-wrap"
            >
              {test.details}
            </pre>
          )}
        </div>
      )}

      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          VMs on this provider
        </p>
        {total === 0 ? (
          <p className="mt-1 text-[11px] text-slate-500">
            No VMs deployed here yet{baseReady ? '' : ' — base image is not ready'}.
          </p>
        ) : (
          <ul aria-label={`VMs on ${host.name}`} className="mt-1 space-y-1.5">
            {vms.map((vm) => (
              <VmRow key={vm.id} vm={vm} providerName={null} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <SecondaryButton
          onClick={() => onTest(host)}
          disabled={testing || busy}
          aria-label={`Test provider ${host.name}`}
          className="px-2.5 py-1.5 text-xs"
        >
          {testing ? 'Testing…' : 'Test provider'}
        </SecondaryButton>
        <span title={deployBlockedReason ?? undefined} className="inline-flex">
          <PrimaryButton
            onClick={() => onDeploy(host)}
            disabled={busy || deployBlockedReason !== null}
            aria-label={`Deploy VM on ${host.name}`}
            className="px-2.5 py-1.5 text-xs"
          >
            Deploy VM
          </PrimaryButton>
        </span>
        <span title={deleteBlockedReason ?? undefined} className="inline-flex">
          <DangerButton
            onClick={() => onDelete(host)}
            disabled={busy || deleteBlocked}
            aria-label={`Delete provider ${host.name}`}
            className="px-2.5 py-1.5 text-xs"
          >
            Delete provider
          </DangerButton>
        </span>
      </div>
      {deleteBlockedReason !== null && (
        <p className="-mt-1 text-[10px] leading-relaxed text-slate-500">{deleteBlockedReason}</p>
      )}
    </article>
  );
}

/**
 * v0.13.1 "VM providers" section: registered KVM/QEMU hosts (zues over libvirt,
 * gpc via local QEMU/KVM), their defaults/base readiness, and the VMs deployed
 * on each. VMs are Computer Use fleet computers with `provider: "vm"`; the
 * summary at the top makes it obvious which PC hosts which running VM.
 */
export function VmProvidersSection() {
  const toast = useToast();
  const providers = useLiveData(() => api.listComputerUseVmHosts(), { intervalMs: PROVIDERS_POLL_MS });
  const fleet = useLiveData(() => api.listComputerUseComputers(), { intervalMs: VMS_POLL_MS });

  const [addOpen, setAddOpen] = useState(false);
  const [deployTarget, setDeployTarget] = useState<ComputerUseVmHostInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ComputerUseVmHostInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestState>>({});

  const hosts = providers.data ?? [];
  const vms = (fleet.data?.computers ?? []).filter(
    (computer) => computer.provider === 'vm',
  ) as ComputerUseComputerInfo[];
  const providerIds = new Set(hosts.map((host) => host.id));
  const vmsByHost = new Map<string, ComputerUseComputerInfo[]>();
  const unassignedVms: ComputerUseComputerInfo[] = [];
  for (const vm of vms) {
    const hostId = vmHostIdOf(vm);
    if (hostId !== null && providerIds.has(hostId)) {
      const existing = vmsByHost.get(hostId) ?? [];
      existing.push(vm);
      vmsByHost.set(hostId, existing);
    } else {
      unassignedVms.push(vm);
    }
  }
  const providerNameById = new Map(hosts.map((host) => [host.id, host.name]));
  const runningVms = vms.filter((vm) => isVmRunning(vm.state));
  const activeVms = vms.filter((vm) => isVmRunning(vm.state) || isVmStarting(vm.state));
  const busy = testingId !== null;

  const runTest = async (host: ComputerUseVmHostInfo): Promise<void> => {
    setTestingId(host.id);
    try {
      const result = await api.testComputerUseVmHost(host.id);
      setTestResults((current) => ({
        ...current,
        [host.id]: { ok: result.ok === true, details: formatTestDetails(result.details) },
      }));
      toast(
        result.ok ? 'success' : 'error',
        result.ok
          ? `${host.name} passed the provider test.`
          : `${host.name} failed the provider test — see details.`,
      );
      providers.refresh();
    } catch (error) {
      const message = formatApiError(error);
      setTestResults((current) => ({
        ...current,
        [host.id]: { ok: false, details: message },
      }));
      toast('error', message);
    } finally {
      setTestingId(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteTarget === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteComputerUseVmHost(deleteTarget.id);
      toast('success', `VM provider ${deleteTarget.name} deleted.`);
      setDeleteTarget(null);
      providers.refresh();
    } catch (error) {
      setDeleteError(formatApiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  let body: ReactNode;
  if (providers.data === null) {
    body =
      providers.loading ? (
        <SkeletonCards count={2} />
      ) : providers.error !== null ? (
        <ErrorState message={providers.error} onRetry={providers.refresh} />
      ) : null;
  } else if (hosts.length === 0) {
    body = (
      <EmptyState
        icon="🗄"
        title="No VM providers registered"
        description="Register a KVM/QEMU host to deploy Computer Use VMs: zues over libvirt/SSH, or gpc using this machine's local QEMU/KVM. Deployed VMs appear in the Computer Use fleet with live frames, stats and the usual tools. This is separate from the physical PCs listed below."
        action={
          <PrimaryButton onClick={() => setAddOpen(true)} className="px-3 py-1.5 text-xs">
            Add VM provider
          </PrimaryButton>
        }
      />
    );
  } else {
    const summaryRows = activeVms.length > 0 ? activeVms : [];
    body = (
      <div className="space-y-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-100">Running VMs</h3>
              <p className="mt-0.5 text-[11px] text-slate-400">
                Which registered provider currently hosts each VM. Timings: the card starts{' '}
                <span className="font-medium text-slate-300">starting</span> during cloud-init, then{' '}
                <span className="font-medium text-slate-300">ready</span> when the connector enrols.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge tone={runningVms.length > 0 ? 'success' : 'neutral'}>
                {runningVms.length} running
              </Badge>
              <Badge tone="neutral">{vms.length} total</Badge>
            </div>
          </div>
          {summaryRows.length === 0 ? (
            <p className="mt-2 text-[11px] text-slate-500">
              No VMs are running. Use <span className="font-medium text-slate-300">Deploy VM</span> on a
              provider card to start one.
            </p>
          ) : (
            <ul aria-label="Running VMs across providers" className="mt-2 space-y-1.5">
              {summaryRows.map((vm) => (
                <VmRow
                  key={vm.id}
                  vm={vm}
                  providerName={
                    vmHostIdOf(vm) !== null
                      ? (providerNameById.get(vmHostIdOf(vm) as string) ?? 'unknown provider')
                      : 'unassigned'
                  }
                />
              ))}
            </ul>
          )}
          {unassignedVms.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-300/80">
              {unassignedVms.length} VM{unassignedVms.length === 1 ? '' : 's'} not linked to a registered
              provider ({unassignedVms.map((vm) => vm.name).join(', ')}). They may belong to a provider
              removed from the registry.
            </p>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {hosts.map((host) => (
            <VmProviderCard
              key={host.id}
              host={host}
              vms={vmsByHost.get(host.id) ?? []}
              test={testResults[host.id] ?? null}
              testing={testingId === host.id}
              busy={busy}
              onTest={(target) => void runTest(target)}
              onDeploy={setDeployTarget}
              onDelete={(target) => {
                setDeleteError(null);
                setDeleteTarget(target);
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby="vm-providers-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="vm-providers-heading" className="text-base font-semibold text-slate-100">
            VM providers
          </h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            KVM/QEMU hosts registered with the broker (zues over libvirt/SSH, gpc via local QEMU/KVM)
            and the VMs deployed on them. VMs are Computer Use computers with{' '}
            <span className="font-mono text-slate-300">provider: vm</span> — they show in the fleet with
            live frames, stats and agent tools.{' '}
            <a
              href="#/computer-use"
              className="text-sky-300 underline decoration-sky-800 underline-offset-2 hover:text-sky-200"
            >
              Open Computer Use ↗
            </a>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={hosts.length > 0 ? 'info' : 'neutral'}>
            {hosts.length} provider{hosts.length === 1 ? '' : 's'}
          </Badge>
          <Badge tone={runningVms.length > 0 ? 'success' : 'neutral'}>
            {runningVms.length} running VM{runningVms.length === 1 ? '' : 's'}
          </Badge>
          <SecondaryButton
            onClick={providers.refresh}
            disabled={providers.refreshing}
            className="px-3 py-1.5 text-xs"
          >
            {providers.refreshing ? 'Refreshing…' : 'Refresh providers'}
          </SecondaryButton>
          <PrimaryButton onClick={() => setAddOpen(true)} className="px-3 py-1.5 text-xs">
            Add VM provider
          </PrimaryButton>
        </div>
      </div>

      {providers.data !== null && providers.error !== null && (
        <Notice tone="warning" title="VM provider list may be stale">
          {providers.error}
        </Notice>
      )}
      {fleet.data !== null && fleet.error !== null && (
        <Notice tone="warning" title="VM list may be stale">
          {fleet.error}
        </Notice>
      )}

      {body}

      <AddVmProviderDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={providers.refresh}
      />

      <DeployVmDialog
        open={deployTarget !== null}
        provider={deployTarget}
        onClose={() => setDeployTarget(null)}
        onCreated={fleet.refresh}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget === null ? 'Delete VM provider' : `Delete VM provider ${deleteTarget.name}`}
        tone="danger"
        confirmLabel="Delete provider"
        cancelLabel="Cancel"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deleteBusy) setDeleteTarget(null);
        }}
      >
        <div className="space-y-2 text-xs text-slate-400">
          <p>
            This removes the provider registration only. The host machine is not modified and its base
            image stays on disk. The broker refuses to delete a provider while any VM still references
            it.
          </p>
          {deleteError !== null && (
            <Notice tone="error" title="Could not delete the provider" onDismiss={() => setDeleteError(null)}>
              {deleteError}
            </Notice>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
