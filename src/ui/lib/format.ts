/** Formatting helpers shared by the console views. All are pure + defensive. */

const PLACEHOLDER = '—';

/** Human readable byte size (binary units). */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return PLACEHOLDER;
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${Math.round(abs)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let value = abs / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? 'PB';
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(digits);
  return `${sign}${fixed} ${unit}`;
}

/** Compact duration: µs / ms / s / m / h. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return PLACEHOLDER;
  const abs = Math.abs(ms);
  if (abs < 1) return `${(abs * 1000).toFixed(0)} µs`;
  if (abs < 1000) return `${abs < 10 ? abs.toFixed(1) : Math.round(abs).toString()} ms`;
  if (abs < 60_000) return `${(abs / 1000).toFixed(2)} s`;
  const totalSeconds = Math.round(abs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

/** Locale-independent `YYYY-MM-DD HH:mm:ss` (local time). */
export function formatTimestamp(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return PLACEHOLDER;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return PLACEHOLDER;
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** Format a 0..1 ratio as a percentage. */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return PLACEHOLDER;
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Group thousands with narrow spaces: 1234 -> "1 234". */
export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return PLACEHOLDER;
  const fixed = value.toFixed(digits);
  const [whole = '', fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
