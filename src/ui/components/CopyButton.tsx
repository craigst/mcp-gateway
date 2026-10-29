import { useState } from 'react';
import { GhostButton, PrimaryButton, SecondaryButton } from './Form.js';

/**
 * Copy `text` to the clipboard, preferring the async Clipboard API and
 * falling back to a hidden textarea + `document.execCommand('copy')`
 * (older browsers, non-secure origins and jsdom).
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / unsupported — try the legacy path below.
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    try {
      textarea.select();
      textarea.setSelectionRange(0, text.length);
      return typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    } finally {
      textarea.parentNode?.removeChild(textarea);
    }
  } catch {
    return false;
  }
}

export interface CopyButtonProps {
  /** Value placed on the clipboard. */
  value: string;
  label?: string;
  copiedLabel?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  className?: string;
  onCopied?: (copied: boolean) => void;
}

/** Button that copies a value and flips its label to "Copied" on success. */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  variant = 'secondary',
  disabled = false,
  className,
  onCopied,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    const ok = await copyTextToClipboard(value);
    setCopied(ok);
    onCopied?.(ok);
  };

  const extra = `${className ?? ''} px-3 py-1.5 text-xs`.trim();
  const text = copied ? copiedLabel : label;

  if (variant === 'primary') {
    return (
      <PrimaryButton onClick={() => void copy()} disabled={disabled} className={extra} aria-live="polite">
        {text}
      </PrimaryButton>
    );
  }
  if (variant === 'ghost') {
    return (
      <GhostButton onClick={() => void copy()} disabled={disabled} aria-live="polite">
        {text}
      </GhostButton>
    );
  }
  return (
    <SecondaryButton onClick={() => void copy()} disabled={disabled} className={extra} aria-live="polite">
      {text}
    </SecondaryButton>
  );
}
