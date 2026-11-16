import type { WatcherSource } from '../../core/types.js';
import type { ReactNode } from 'react';

/** Decorative channel marks: the adjacent text supplies the accessible name. */
export function SocialIcon({ source }: { source: WatcherSource }) {
  const paths: Record<WatcherSource, ReactNode> = {
    whatsapp: <><path d="M20.3 11.8a8.3 8.3 0 0 1-12.2 7.3L4 20l1.1-4a8.3 8.3 0 1 1 15.2-4.2Z"/><path d="M8.4 8.2c.2-.4.5-.4.8-.4l.7 1.6-.5.7c.4.9 1.4 1.8 2.3 2.3l.7-.5 1.6.7c0 .4 0 .6-.4.9-.4.3-1 .5-1.6.3-2-.6-4.5-3-5-5-.1-.3.1-.5.4-.6Z"/></>,
    instagram: <><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.4" cy="6.7" r=".9" fill="currentColor" stroke="none"/></>,
    youtube: <><rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="m10 9 5 3-5 3Z"/></>,
    x: <><path d="M4 4h4l12 16h-4L4 4Z"/><path d="m19 4-6.3 7.2M11 13 5 20"/></>,
  };
  return <svg aria-hidden="true" className={`social-icon social-icon-${source}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[source]}</svg>;
}
