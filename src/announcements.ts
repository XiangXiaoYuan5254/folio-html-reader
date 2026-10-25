import { useEffect, useSyncExternalStore } from 'react';
import { invoke, isDesktop } from './api';

export type Announcement = {
  id: string;
  vendor: string;
  title: string;
  benefit: string;
  conditions: string;
  url: string;
  preset: string;
  evidence: string;
  expires: number | null;
  checked: number;
  published: number;
};
export type AnnouncementFeed = {
  items: Announcement[];
  updatedAt: number;
  fetchedAt: number;
  cached?: boolean;
  offline?: boolean;
};

// All entry points share the existing read marker, including the standalone AI window.
const seenKey = 'folio.announcements-seen';
// A window that stays open still hears about new offers. The main process keeps its
// copy for 30 minutes, so most of these checks cost no request.
const pollEvery = 6 * 60 * 60_000;
let latest = 0;
let unseen = false;
let loading: Promise<AnnouncementFeed> | null = null;
const listeners = new Set<() => void>();
function seen() {
  try {
    return Number(localStorage.getItem(seenKey)) || 0;
  } catch {
    return 0;
  }
}
let readThrough = seen();
function newest(feed: AnnouncementFeed) {
  const now = Date.now();
  return Math.max(
    0,
    ...feed.items
      .filter((item) => !item.expires || item.expires > now)
      .map((item) => Number(item.published) || 0),
  );
}
function publish() {
  const next = latest > readThrough;
  if (next === unseen) return;
  unseen = next;
  listeners.forEach((listener) => listener());
}
export function loadAnnouncements(force = false): Promise<AnnouncementFeed> {
  // Reopening settings may overlap a previous check. A requested refresh must run
  // after that response, rather than reusing a request sent before the window opened.
  if (loading && force) return loading.catch(() => {}).then(() => loadAnnouncements(true));
  loading ||= invoke<AnnouncementFeed>('announcements', { force })
    .then((feed) => {
      latest = newest(feed);
      publish();
      return feed;
    })
    .finally(() => (loading = null));
  return loading;
}
export function markAnnouncementsSeen(feed: AnnouncementFeed) {
  // A late response from an older page must never move the marker backwards.
  readThrough = Math.max(readThrough, seen(), newest(feed));
  try {
    if (readThrough) localStorage.setItem(seenKey, String(readThrough));
  } catch {}
  publish();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useUnreadAnnouncements() {
  useEffect(() => {
    if (!isDesktop) return;
    void loadAnnouncements().catch(() => {});
    const timer = setInterval(() => void loadAnnouncements().catch(() => {}), pollEvery);
    return () => clearInterval(timer);
  }, []);
  return useSyncExternalStore(subscribe, () => unseen);
}
