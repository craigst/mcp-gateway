/** Browser download + local file helpers for encrypted backups. */

/**
 * Save a Blob to the user's downloads. Returns false in non-browser/test
 * environments where object URLs are unavailable.
 */
export function triggerBrowserDownload(blob: Blob, fileName: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    const revoke = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL : null;
    if (revoke !== null) setTimeout(() => revoke(url), 0);
  }
}

/** Read a File as UTF-8 text with a FileReader fallback (older browsers/jsdom). */
export async function readFileAsText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the selected file.'));
    reader.readAsText(file);
  });
}

/** Read a backup file and parse its JSON envelope. */
export async function readBackupFile(file: File): Promise<unknown> {
  const text = await readFileAsText(file);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('The selected file is not a valid JSON backup (.mcpbak).');
  }
}
