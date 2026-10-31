import { useEffect, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Notice } from '../../components/States.js';
import { Badge } from '../../components/Badge.js';
import { CheckboxField, Field, Select, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type {
  ComputerUseVmHostConfigInput,
  ComputerUseVmHostCreateResult,
  ComputerUseVmHostKind,
} from '../../../core/types.js';
import {
  formatTestDetails,
  testOkFlag,
  providerStateTone,
  VM_CPU_MAX,
  VM_CPU_MIN,
  VM_DISK_MAX_GB,
  VM_DISK_MIN_GB,
  VM_MEMORY_MAX_MB,
  VM_MEMORY_MIN_MB,
  parseIntInRange,
} from './vmShared.js';

export interface AddVmProviderDialogProps {
  open: boolean;
  onClose: () => void;
  /** Refresh the provider cards after registration. */
  onCreated: () => void;
}

/**
 * "Add VM provider" dialog: register a KVM/QEMU host that can run Computer Use
 * VMs. The broker runs `ensure_base()` + `test()` before storing the provider,
 * so this can take a few minutes; the result (and its details) is shown in
 * phase two.
 */
export function AddVmProviderDialog({ open, onClose, onCreated }: AddVmProviderDialogProps) {
  const toast = useToast();
  const [name, setName] = useState('zues');
  const [kind, setKind] = useState<ComputerUseVmHostKind>('libvirt');
  const [sshHost, setSshHost] = useState('zues');
  const [sshUser, setSshUser] = useState('root');
  const [baseImage, setBaseImage] = useState('');
  const [storageDir, setStorageDir] = useState('');
  const [network, setNetwork] = useState('');
  const [vcpus, setVcpus] = useState('4');
  const [memoryMb, setMemoryMb] = useState('8192');
  const [diskGb, setDiskGb] = useState('30');
  const [installBrowser, setInstallBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComputerUseVmHostCreateResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('zues');
    setKind('libvirt');
    setSshHost('zues');
    setSshUser('root');
    setBaseImage('');
    setStorageDir('');
    setNetwork('');
    setVcpus('4');
    setMemoryMb('8192');
    setDiskGb('30');
    setInstallBrowser(false);
    setBusy(false);
    setError(null);
    setResult(null);
  }, [open]);

  const parsedVcpus = parseIntInRange(vcpus, VM_CPU_MIN, VM_CPU_MAX);
  const parsedMemory = parseIntInRange(memoryMb, VM_MEMORY_MIN_MB, VM_MEMORY_MAX_MB);
  const parsedDisk = parseIntInRange(diskGb, VM_DISK_MIN_GB, VM_DISK_MAX_GB);
  const invalidReason =
    name.trim() === ''
      ? 'Give the provider a name.'
      : baseImage.trim() === ''
        ? 'Base image path is required.'
        : storageDir.trim() === ''
          ? 'Storage directory is required.'
          : kind === 'libvirt' && sshHost.trim() === ''
            ? 'SSH host is required for libvirt providers.'
            : kind === 'libvirt' && sshUser.trim() === ''
              ? 'SSH user is required for libvirt providers.'
              : parsedVcpus === null
                ? `Default vCPUs must be ${VM_CPU_MIN}–${VM_CPU_MAX}.`
                : parsedMemory === null
                  ? `Default memory must be ${VM_MEMORY_MIN_MB}–${VM_MEMORY_MAX_MB} MB.`
                  : parsedDisk === null
                    ? `Default disk must be ${VM_DISK_MIN_GB}–${VM_DISK_MAX_GB} GB.`
                    : null;

  const submit = async (): Promise<void> => {
    if (invalidReason !== null || parsedVcpus === null || parsedMemory === null || parsedDisk === null) {
      setError(invalidReason ?? 'Check the provider fields.');
      return;
    }
    const config: ComputerUseVmHostConfigInput = {
      baseImage: baseImage.trim(),
      storageDir: storageDir.trim(),
      defaults: { vcpus: parsedVcpus, memoryMb: parsedMemory, diskGb: parsedDisk },
      installBrowser,
    };
    if (kind === 'libvirt') {
      config.sshHost = sshHost.trim();
      config.sshUser = sshUser.trim();
    }
    if (network.trim() !== '') config.network = network.trim();

    setBusy(true);
    setError(null);
    try {
      const created = await api.createComputerUseVmHost({ name: name.trim(), kind, config });
      setResult(created);
      toast('success', `VM provider ${created.vmHost.name} registered.`);
      onCreated();
    } catch (createError) {
      setError(formatApiError(createError));
    } finally {
      setBusy(false);
    }
  };

  const registered = result?.vmHost ?? null;
  const testOk = result === null ? null : testOkFlag(result.test);
  const testDetails = result === null ? '' : formatTestDetails(result.test);

  return (
    <ConfirmDialog
      open={open}
      title="Add VM provider"
      description={
        result === null
          ? 'Register a KVM/QEMU host that can run Computer Use VMs. The broker tests SSH, the base image, storage and KVM before saving the provider.'
          : 'The provider is registered. Deploy VMs from its card; they appear in the Computer Use fleet once the guest connector enrols.'
      }
      size="lg"
      busy={busy}
      confirmLabel={result === null ? 'Register provider' : 'Done'}
      cancelLabel={result === null ? 'Cancel' : 'Close'}
      confirmDisabled={result === null && invalidReason !== null}
      onConfirm={() => {
        if (busy) return;
        if (result === null) void submit();
        else onClose();
      }}
      onCancel={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div className="space-y-4">
        {result === null ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider name" hint="e.g. zues (Unraid/libvirt) or gpc (local QEMU/KVM).">
                <TextInput
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="zues"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
              <Field label="Kind" hint="libvirt = remote host over SSH; qemu = this broker host's /dev/kvm.">
                <Select
                  value={kind}
                  onChange={(event) => setKind(event.target.value === 'qemu' ? 'qemu' : 'libvirt')}
                  disabled={busy}
                >
                  <option value="libvirt">libvirt (SSH)</option>
                  <option value="qemu">qemu (local KVM)</option>
                </Select>
              </Field>
            </div>

            {kind === 'libvirt' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="SSH host" hint="Hostname or address the broker can reach (e.g. zues).">
                  <TextInput
                    value={sshHost}
                    onChange={(event) => setSshHost(event.target.value)}
                    placeholder="zues"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                </Field>
                <Field label="SSH user" hint="User with virsh + qemu-img access.">
                  <TextInput
                    value={sshUser}
                    onChange={(event) => setSshUser(event.target.value)}
                    placeholder="root"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                  />
                </Field>
              </div>
            )}

            <Field
              label="Base image path"
              hint={
                kind === 'libvirt'
                  ? 'Ubuntu cloud image on the remote host (overlaid per VM).'
                  : 'Pre-sized cloud image on this host — the base must be at least as large as the biggest VM disk.'
              }
            >
              <TextInput
                value={baseImage}
                onChange={(event) => setBaseImage(event.target.value)}
                placeholder={
                  kind === 'libvirt'
                    ? '/mnt/user/domains/brk/base/noble-server-cloudimg-amd64.img'
                    : '/home/craigst/.local/share/computer-broker/vm/base/noble-30g.img'
                }
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Storage directory"
                hint={kind === 'libvirt' ? 'VM disks/overlays on the remote host.' : 'VM disks on this host.'}
              >
                <TextInput
                  value={storageDir}
                  onChange={(event) => setStorageDir(event.target.value)}
                  placeholder={
                    kind === 'libvirt'
                      ? '/mnt/user/domains/brk/vms'
                      : '/home/craigst/.local/share/computer-broker/vm/vms'
                  }
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
              <Field label="Network (optional)" hint={kind === 'libvirt' ? 'libvirt network, default: default.' : 'QEMU networking; NAT user networking by default.'}>
                <TextInput
                  value={network}
                  onChange={(event) => setNetwork(event.target.value)}
                  placeholder={kind === 'libvirt' ? 'default' : 'user'}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Default vCPUs" hint={`${VM_CPU_MIN}–${VM_CPU_MAX}`}>
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
              <Field label="Default memory (MB)" hint={`${VM_MEMORY_MIN_MB}–${VM_MEMORY_MAX_MB}`}>
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
              <Field label="Default disk (GB)" hint={`${VM_DISK_MIN_GB}–${VM_DISK_MAX_GB}`}>
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

            <CheckboxField
              label="Install Chrome in each VM (optional)"
              checked={installBrowser}
              onChange={setInstallBrowser}
              disabled={busy}
            />

            <Notice tone="info" title="Registration runs a provider test">
              The broker checks SSH (libvirt), the base image, storage permissions and KVM/TCG, then
              saves the provider. This can take a few minutes; the details are shown here.
            </Notice>

            {error !== null && (
              <Notice tone="error" title="Could not register the provider" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success">provider registered</Badge>
              {registered !== null && (
                <>
                  <Badge tone={providerStateTone(registered.state)}>{registered.state}</Badge>
                  <Badge tone={registered.baseReady ? 'success' : 'warning'}>
                    {registered.baseReady ? 'base image ready' : 'base image missing'}
                  </Badge>
                  <span className="text-[11px] text-slate-500">
                    {registered.name} · {registered.kind}
                  </span>
                </>
              )}
            </div>

            <Notice
              tone={testOk === true ? 'success' : testOk === false ? 'error' : 'info'}
              title={
                testOk === true
                  ? 'Provider test passed'
                  : testOk === false
                    ? 'Provider test reported a problem'
                    : 'Provider test result'
              }
            >
              {testOk === true
                ? 'The broker reached the provider and verified the base image, storage and KVM.'
                : testOk === false
                  ? 'The provider was saved, but its test reported a problem. Check the details and re-test it from the provider card.'
                  : 'Registered. Use Test provider on the card to re-run the broker test.'}
            </Notice>

            {testDetails !== '' && (
              <pre
                aria-label="Provider test details"
                className="max-h-56 overflow-auto rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap"
              >
                {testDetails}
              </pre>
            )}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
