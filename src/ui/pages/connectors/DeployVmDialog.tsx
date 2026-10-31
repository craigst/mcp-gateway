import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { Badge } from '../../components/Badge.js';
import { Field, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type { ComputerUseVmHostInfo } from '../../../core/types.js';
import {
  formatMemoryMb,
  providerDefaults,
  VM_CPU_MAX,
  VM_CPU_MIN,
  VM_DISK_MAX_GB,
  VM_DISK_MIN_GB,
  VM_MEMORY_MAX_MB,
  VM_MEMORY_MIN_MB,
  parseIntInRange,
} from './vmShared.js';

export interface DeployVmDialogProps {
  open: boolean;
  provider: ComputerUseVmHostInfo | null;
  onClose: () => void;
  /** Refresh the provider cards + VM summary after a deploy. */
  onCreated: () => void;
}

/**
 * "Deploy VM" dialog: name plus vCPU / memory / disk prefilled from the
 * provider defaults. The broker creates and starts the VM synchronously; the
 * computer then shows as `starting` until cloud-init enrols the connector.
 */
export function DeployVmDialog({ open, provider, onClose, onCreated }: DeployVmDialogProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [vcpus, setVcpus] = useState('2');
  const [memoryMb, setMemoryMb] = useState('4096');
  const [diskGb, setDiskGb] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || provider === null) return;
    const defaults = providerDefaults(provider);
    setName(`${provider.name}-vm`);
    setVcpus(String(defaults.vcpus));
    setMemoryMb(String(defaults.memoryMb));
    setDiskGb(String(defaults.diskGb));
    setBusy(false);
    setError(null);
  }, [open, provider]);

  const defaults = provider === null ? null : providerDefaults(provider);
  const parsedVcpus = parseIntInRange(vcpus, VM_CPU_MIN, VM_CPU_MAX);
  const parsedMemory = parseIntInRange(memoryMb, VM_MEMORY_MIN_MB, VM_MEMORY_MAX_MB);
  const parsedDisk = parseIntInRange(diskGb, VM_DISK_MIN_GB, VM_DISK_MAX_GB);
  const nameInvalid = name.trim() === '';
  const invalid = nameInvalid || parsedVcpus === null || parsedMemory === null || parsedDisk === null;

  const submit = async (): Promise<void> => {
    if (provider === null || parsedVcpus === null || parsedMemory === null || parsedDisk === null) return;
    if (name.trim() === '') {
      setError('Give the VM a name first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createComputerUseVm({
        vmHostId: provider.id,
        name: name.trim(),
        vcpus: parsedVcpus,
        memoryMb: parsedMemory,
        diskGb: parsedDisk,
      });
      toast(
        'success',
        `${created.name} is starting on ${provider.name} — first boot takes 3–8 minutes until it appears ready in Computer Use.`,
      );
      onCreated();
      onClose();
    } catch (deployError) {
      setError(formatApiError(deployError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title={provider === null ? 'Deploy VM' : `Deploy VM on ${provider.name}`}
      description="Creates a qcow2/overlay disk, builds the cloud-init seed and starts the VM on this provider. The VM then enrols as a normal Computer Use computer."
      size="lg"
      busy={busy}
      confirmLabel="Deploy VM"
      cancelLabel="Cancel"
      confirmDisabled={invalid}
      onConfirm={() => void submit()}
      onCancel={() => {
        if (!busy) onClose();
      }}
    >
      <div className="space-y-4">
        {provider !== null && defaults !== null && (
          <p className="text-[11px] text-slate-500">
            Provider <span className="font-semibold text-slate-300">{provider.name}</span> (
            {provider.kind}) · defaults {defaults.vcpus} vCPU, {formatMemoryMb(defaults.memoryMb)} RAM,{' '}
            {defaults.diskGb} GB disk
            {provider.baseReady ? '' : ' · base image not ready — the deploy may fail until the provider is tested'}
            .
          </p>
        )}

        <Field label="VM name" hint="Shown in the Computer Use fleet and in the VM providers list.">
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="research-1"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="vCPUs"
            hint={`${VM_CPU_MIN}–${VM_CPU_MAX}`}
            error={vcpus.trim() !== '' && parsedVcpus === null ? 'Out of range.' : undefined}
          >
            <TextInput
              type="number"
              inputMode="numeric"
              min={VM_CPU_MIN}
              max={VM_CPU_MAX}
              step={1}
              value={vcpus}
              onChange={(event) => setVcpus(event.target.value)}
              disabled={busy}
            />
          </Field>
          <Field
            label="Memory (MB)"
            hint={`${VM_MEMORY_MIN_MB}–${VM_MEMORY_MAX_MB}`}
            error={memoryMb.trim() !== '' && parsedMemory === null ? 'Out of range.' : undefined}
          >
            <TextInput
              type="number"
              inputMode="numeric"
              min={VM_MEMORY_MIN_MB}
              max={VM_MEMORY_MAX_MB}
              step={512}
              value={memoryMb}
              onChange={(event) => setMemoryMb(event.target.value)}
              disabled={busy}
            />
          </Field>
          <Field
            label="Disk (GB)"
            hint={`${VM_DISK_MIN_GB}–${VM_DISK_MAX_GB}`}
            error={diskGb.trim() !== '' && parsedDisk === null ? 'Out of range.' : undefined}
          >
            <TextInput
              type="number"
              inputMode="numeric"
              min={VM_DISK_MIN_GB}
              max={VM_DISK_MAX_GB}
              step={1}
              value={diskGb}
              onChange={(event) => setDiskGb(event.target.value)}
              disabled={busy}
            />
          </Field>
        </div>

        <Notice tone="info" title="What happens next">
          The VM boots Ubuntu 24.04 with Xvfb + Xfce and the broker connector. It stays{' '}
          <Badge tone="warning">starting</Badge> for roughly 3–8 minutes, then becomes{' '}
          <Badge tone="success">ready</Badge> in this list and on the Computer Use page. NAT networking
          only — the guest dials out to the broker.
        </Notice>

        {error !== null && (
          <Notice tone="error" title="Could not deploy the VM" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}
      </div>
    </ConfirmDialog>
  );
}
