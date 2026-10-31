/** Shared helpers for the v0.13.1 VM providers console section. */
import type { BadgeTone } from '../../components/Badge.js';
import type {
  ComputerUseComputerInfo,
  ComputerUseVmHostConfig,
  ComputerUseVmHostDefaults,
  ComputerUseVmHostInfo,
} from '../../../core/types.js';

/** Fallbacks when a provider does not report its own defaults. */
export const FALLBACK_VM_DEFAULTS: VmProviderDefaults = { vcpus: 2, memoryMb: 4_096, diskGb: 30 };

export interface VmProviderDefaults {
  vcpus: number;
  memoryMb: number;
  diskGb: number;
}

const VM_RUNNING_STATES = new Set(['ready', 'online', 'running', 'active', 'available']);

/** True when a VM computer is up (or close enough to count as running). */
export function isVmRunning(state: string | null | undefined): boolean {
  if (state === null || state === undefined) return false;
  return VM_RUNNING_STATES.has(state.trim().toLowerCase());
}

/** Badge tone for a provider state (`ready` / `new` / `error`). */
export function providerStateTone(state: string | null | undefined): BadgeTone {
  const normalised = (state ?? '').trim().toLowerCase();
  if (normalised === 'ready' || normalised === 'online') return 'success';
  if (normalised === 'error' || normalised === 'failed') return 'danger';
  if (normalised === 'new' || normalised === 'pending' || normalised === 'testing') return 'warning';
  return 'neutral';
}

/** True when a VM computer state is transitional (VM booting / cloud-init). */
export function isVmStarting(state: string | null | undefined): boolean {
  const normalised = (state ?? '').trim().toLowerCase();
  return normalised === 'starting' || normalised === 'provisioning' || normalised === 'booting';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Provider config (never null in practice; guard for older payloads). */
export function providerConfig(host: ComputerUseVmHostInfo): ComputerUseVmHostConfig | null {
  return isRecord(host.config) ? host.config : null;
}

/** Provider defaults come from `defaults`, falling back to `config.defaults`. */
export function providerDefaults(host: ComputerUseVmHostInfo): VmProviderDefaults {
  const config = providerConfig(host);
  const record: Partial<ComputerUseVmHostDefaults> = isRecord(host.defaults) ? host.defaults : {};
  const nested: Partial<ComputerUseVmHostDefaults> = isRecord(config?.defaults) ? config.defaults : {};
  return {
    vcpus: pickNumber(record.vcpus, nested.vcpus) ?? FALLBACK_VM_DEFAULTS.vcpus,
    memoryMb:
      pickNumber(record.memoryMb, nested.memoryMb) ?? FALLBACK_VM_DEFAULTS.memoryMb,
    diskGb: pickNumber(record.diskGb, nested.diskGb) ?? FALLBACK_VM_DEFAULTS.diskGb,
  };
}

/** `root@zues` for libvirt, `local KVM (/dev/kvm)` for qemu. */
export function providerEndpoint(host: ComputerUseVmHostInfo): string | null {
  if (host.kind === 'qemu') return 'local KVM (/dev/kvm)';
  const config = providerConfig(host);
  const sshHost = asNonEmptyString(config?.sshHost) ?? asNonEmptyString(config?.host);
  const sshUser = asNonEmptyString(config?.sshUser) ?? asNonEmptyString(config?.user);
  if (sshHost === null) return null;
  return sshUser !== null ? `${sshUser}@${sshHost}` : sshHost;
}

export function providerBaseImage(host: ComputerUseVmHostInfo): string | null {
  return asNonEmptyString(providerConfig(host)?.baseImage);
}

export function providerStorageDir(host: ComputerUseVmHostInfo): string | null {
  const config = providerConfig(host);
  return asNonEmptyString(config?.storageDir) ?? asNonEmptyString(config?.vmDir);
}

export function providerNetwork(host: ComputerUseVmHostInfo): string | null {
  return asNonEmptyString(providerConfig(host)?.network);
}

/** `4 vCPU · 8 GB RAM · 30 GB disk`, from a VM computer's resources block. */
export function vmResourcesSummary(computer: ComputerUseComputerInfo): string | null {
  const resources = computer.resources ?? null;
  if (resources === null) return null;
  const parts: string[] = [];
  if (resources.vcpus !== null) parts.push(`${Math.round(resources.vcpus)} vCPU`);
  if (resources.memoryMb !== null) parts.push(`${formatMemoryMb(resources.memoryMb)} RAM`);
  if (resources.diskGb !== null) parts.push(`${Math.round(resources.diskGb)} GB disk`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** VM provider id this computer belongs to (`resources.vmHostId`). */
export function vmHostIdOf(computer: ComputerUseComputerInfo): string | null {
  return asNonEmptyString(computer.resources?.vmHostId);
}

/** `8 GB` / `512 MB` — memory defaults are always reported in MB. */
export function formatMemoryMb(memoryMb: number | null | undefined): string {
  if (memoryMb === null || memoryMb === undefined || !Number.isFinite(memoryMb)) return '—';
  if (memoryMb < 1024) return `${Math.round(memoryMb)} MB`;
  const gb = memoryMb / 1024;
  const rounded = Math.round(gb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
}

/** Pretty-print a provider test payload (broker output varies by kind). */
export function formatTestDetails(details: unknown): string {
  if (details === null || details === undefined) return '';
  if (typeof details === 'string') return details.trim();
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

/** `ok` flag from a broker test payload, when it carries one. */
export function testOkFlag(test: unknown): boolean | null {
  if (typeof test === 'boolean') return test;
  if (isRecord(test) && typeof test.ok === 'boolean') return test.ok;
  return null;
}

/** Validate the deploy dialog's integer fields (backend clamps, UI explains). */
export const VM_CPU_MIN = 1;
export const VM_CPU_MAX = 16;
export const VM_MEMORY_MIN_MB = 512;
export const VM_MEMORY_MAX_MB = 65_536;
export const VM_DISK_MIN_GB = 10;
export const VM_DISK_MAX_GB = 500;

/** Parse a whole-number field inside [min,max]; null when invalid. */
export function parseIntInRange(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}
