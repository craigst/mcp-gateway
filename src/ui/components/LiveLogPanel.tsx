import { useEffect, useRef, useState } from 'react';
import { formatTimestamp } from '../lib/format.js';
import { cx } from '../lib/cx.js';
import { Badge } from './Badge.js';

export interface LiveLogLine {
  ts: string;
  stream: string;
  line: string;
  serverId?: string;
}

type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'unavailable';

interface LogFrame {
  type?: string;
  serverId?: string;
  ts?: string;
  stream?: string;
  line?: string;
}

function defaultGatewayOrigin(): string {
  if (typeof window === 'undefined') return 'ws://127.0.0.1:8080';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

/**
 * Build the browser WebSocket URL. The HttpOnly session cookie is sent with the
 * same-origin handshake automatically, so no key is placed in the query string.
 */
export function buildLogSocketUrl(origin: string, serverId?: string | null): string {
  const url = new URL('/mcp/v1/admin/ws/logs', origin.replace(/^ws/, 'http'));
  if (serverId) url.searchParams.set('serverId', serverId);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${url.host}${url.pathname}${url.search}`;
}

function statusTone(status: SocketStatus): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'open') return 'success';
  if (status === 'connecting' || status === 'reconnecting') return 'warning';
  if (status === 'unauthorized' || status === 'unavailable') return 'danger';
  return 'neutral';
}

const STATUS_LABEL: Record<SocketStatus, string> = {
  idle: 'idle',
  connecting: 'connecting',
  open: 'live',
  reconnecting: 'reconnecting',
  unauthorized: 'unauthorized',
  unavailable: 'offline',
};

const STREAM_COLOR: Record<string, string> = {
  stdout: 'text-slate-300',
  stderr: 'text-rose-300',
  system: 'text-sky-300',
};

export interface LiveLogPanelProps {
  /** `null` subscribes to every running sub-server. */
  serverId?: string | null;
  maxLines?: number;
  className?: string;
}

/** Terminal-style live log viewer over the admin WebSocket with auto-reconnect. */
export function LiveLogPanel({ serverId = null, maxLines = 500, className }: LiveLogPanelProps) {
  const [lines, setLines] = useState<LiveLogLine[]>([]);
  const [status, setStatus] = useState<SocketStatus>('idle');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    setLines([]);

    const connect = (): void => {
      if (disposed) return;
      if (typeof WebSocket === 'undefined') {
        setStatus('unavailable');
        return;
      }
      setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        socket = new WebSocket(buildLogSocketUrl(defaultGatewayOrigin(), serverId));
      } catch {
        setStatus('unavailable');
        return;
      }

      socket.onopen = () => {
        attempt = 0;
        setStatus('open');
      };

      socket.onmessage = (event: MessageEvent) => {
        let frame: LogFrame;
        try {
          frame = JSON.parse(String(event.data)) as LogFrame;
        } catch {
          return;
        }
        if (frame.type !== 'log' || typeof frame.line !== 'string') return;
        const line = frame.line;
        const ts = typeof frame.ts === 'string' ? frame.ts : new Date().toISOString();
        const stream = typeof frame.stream === 'string' ? frame.stream : 'stdout';
        const serverIdForLine = typeof frame.serverId === 'string' ? frame.serverId : undefined;
        setLines((previous) => {
          const next: LiveLogLine[] = [
            ...previous,
            {
              ts,
              stream,
              line,
              serverId: serverIdForLine,
            },
          ];
          return next.length > maxLines ? next.slice(next.length - maxLines) : next;
        });
      };

      socket.onclose = (event: CloseEvent) => {
        if (disposed) return;
        if (event.code === 4401) {
          setStatus('unauthorized');
          return;
        }
        attempt += 1;
        if (attempt > 5) {
          setStatus('unavailable');
          return;
        }
        setStatus('reconnecting');
        retryTimer = setTimeout(connect, Math.min(1000 * attempt, 5000));
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [serverId, maxLines]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <Badge tone={statusTone(status)}>
          <span
            aria-hidden="true"
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              status === 'open' ? 'bg-emerald-400' : status === 'reconnecting' || status === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-rose-400',
            )}
          />
          {STATUS_LABEL[status]}
        </Badge>
        <button
          type="button"
          onClick={() => setLines([])}
          className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:bg-slate-800"
        >
          Clear
        </button>
      </div>
      <div
        ref={scrollRef}
        className="terminal-scroll h-64 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/90 p-3 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <p className="text-slate-600">
            {status === 'unavailable'
              ? 'Live logs unavailable — sign in to the console first.'
              : 'Waiting for log frames…'}
          </p>
        ) : (
          lines.map((log, index) => (
            <div key={`${log.ts}-${index}`} className="grid grid-cols-[minmax(0,8.5rem)_auto] gap-2">
              <span className="truncate text-slate-600">{formatTimestamp(log.ts)}</span>
              <span className={cx('whitespace-pre-wrap break-words', STREAM_COLOR[log.stream] ?? 'text-slate-300')}>
                <span className="mr-1.5 text-slate-500">[{log.stream}]</span>
                {log.serverId ? <span className="mr-1.5 text-indigo-400">{log.serverId}</span> : null}
                {log.line}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
