import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from '../lib/cx.js';

export const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 disabled:opacity-50';

export const textareaClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 placeholder:text-slate-600 disabled:opacity-50';

export const buttonPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50';

export const buttonSecondary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50';

export const buttonDanger =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-800 px-3 py-2 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-950/40 disabled:cursor-not-allowed disabled:opacity-50';

export const buttonGhost =
  'inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40';

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, className, children }: FieldProps) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
      {error !== undefined && <span className="mt-1 block text-[11px] text-rose-400">{error}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input {...rest} className={cx(inputClass, className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, ...rest } = props;
  return <textarea {...rest} className={cx(textareaClass, className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, ...rest } = props;
  return (
    <select {...rest} className={cx(inputClass, 'pr-8', className)}>
      {children}
    </select>
  );
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, type = 'button', ...rest } = props;
  return <button {...rest} type={type} className={cx(buttonPrimary, className)} />;
}

export function SecondaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, type = 'button', ...rest } = props;
  return <button {...rest} type={type} className={cx(buttonSecondary, className)} />;
}

export function DangerButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, type = 'button', ...rest } = props;
  return <button {...rest} type={type} className={cx(buttonDanger, className)} />;
}

export function GhostButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, type = 'button', ...rest } = props;
  return <button {...rest} type={type} className={cx(buttonGhost, className)} />;
}

export interface CheckboxFieldProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function CheckboxField({ label, checked, onChange, disabled = false, className }: CheckboxFieldProps) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-2 text-xs text-slate-300', disabled && 'cursor-not-allowed opacity-60', className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 accent-sky-500"
      />
      <span>{label}</span>
    </label>
  );
}
