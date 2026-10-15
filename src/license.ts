import { useSyncExternalStore } from 'react';
import { invoke, isDesktop, subscribe } from './api';

export type Plan = 'month' | 'year' | 'life';
// The membership as electron/license.cjs reads it from the server's signed lease.
export type LicenseStatus = {
  member: boolean;
  // trial / paid: a member. offline: a member who hasn't reached the server for a week.
  // clock: the computer's clock was turned back. expired: was a member. none: never was.
  state: 'trial' | 'paid' | 'offline' | 'clock' | 'expired' | 'none';
  // A lifetime membership: no `expires`.
  forever?: boolean;
  // What the server last said this computer had: 'paid' for a paying member, also while
  // offline or clock.
  kind?: 'paid' | 'trial' | null;
  expires: number | null;
  trialUsed: boolean;
  codes: { code: string; plan: Plan; revoked?: boolean }[];
  // Why the last check didn't reach the server, if it didn't.
  error?: string;
};
// A code that is on another computer: it can be moved here, at most once a week.
export type Refusal = {
  code: 'in-use' | 'move-too-soon';
  message: string;
  platform: string | null;
  canMoveAt: number | null;
};

// What can be bought, in fen. `later`: the price after an early-bird price ends at `until`.
// `credit`: taken off lifetime for the days left of memberships bought on this computer.
// `discount`: taken off by a friend's invite code.
export type Offer = {
  ready: boolean;
  plans: {
    plan: Plan;
    days: number;
    amount: number;
    credit?: number;
    discount?: number;
    later?: number;
    until?: number;
  }[];
  inviteCode?: InviteCode;
};
// Inviting friends, while the server runs the offer. `code`: this computer's own, `share` the
// invite to send with it, `used` once a friend has bought with it (it works for one friend).
// `first`: this computer hasn't paid yet, so a friend's code counts; `friend` is the one typed
// in, with why it doesn't count if it doesn't. `discount`: what a code takes off each plan it
// works for, in fen.
export type InviteCode = {
  code: string;
  share: string;
  used: boolean;
  first: boolean;
  friend?: { code: string; error?: string };
  discount: Partial<Record<Plan, number>>;
};
// A purchase waiting to be paid: `payUrl` is the checkout page, shown as a QR code. 简付 closes
// it unpaid after about 15 minutes (`closed`).
export type Order = { no: string; plan: Plan; amount: number; payUrl: string; closed?: boolean };

// The browser preview (npm run dev:web) has no membership to check.
const always: LicenseStatus = {
  member: true,
  state: 'paid',
  expires: null,
  trialUsed: true,
  codes: [],
};
let status: LicenseStatus | null = isDesktop ? null : always;
let loading: Promise<LicenseStatus> | null = null;
const listeners = new Set<() => void>();
function set(next: LicenseStatus) {
  status = next;
  listeners.forEach((l) => l());
}
if (isDesktop) subscribe((e) => e.type === 'license' && set(e.status));
export function loadLicense(): Promise<LicenseStatus> {
  if (!isDesktop) return Promise.resolve(always);
  loading ||= invoke<LicenseStatus>('license')
    .then((s) => (set(s), s))
    .finally(() => (loading = null));
  return loading;
}
export function useLicense() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (!status) void loadLicense();
      return () => listeners.delete(l);
    },
    () => status,
  );
}
export const renewLicense = () => invoke<LicenseStatus>('license-renew').then((s) => (set(s), s));
export const recoverLicense = () =>
  invoke<LicenseStatus>('license-recover').then((s) => (set(s), s));
export async function activateLicense(code: string, move = false) {
  const r = await invoke<{ status?: LicenseStatus; refusal?: Refusal }>('license-activate', {
    code,
    move,
  });
  if (r.status) set(r.status);
  return r;
}
export const startTrial = () => invoke<LicenseStatus>('license-trial').then((s) => (set(s), s));
export const getOffer = () => invoke<Offer>('license-offer');
// Keeps a friend's invite code for this computer's first purchase ('' forgets it).
export const setInvite = (code: string) => invoke<Offer>('license-invite', { code });
export const createOrder = (plan: Plan, invite?: string) =>
  invoke<Order>('license-order', { plan, invite });
export async function checkOrder() {
  const r = await invoke<{ paid: boolean; closed: boolean; status: LicenseStatus }>(
    'license-order-status',
  );
  set(r.status);
  return r;
}

// Opens the membership dialog (App listens), saying what was asked for.
export function askMembership(reason = '') {
  window.dispatchEvent(new CustomEvent('folio-membership', { detail: reason }));
}
// Before a member feature: true if it may go ahead. Otherwise the dialog explains, after one
// more try at the server when the membership is only waiting to be confirmed.
export async function requireMember(reason: string) {
  if (!isDesktop) return true;
  let s = status || (await loadLicense().catch(() => null));
  if (s && !s.member && (s.state === 'offline' || s.state === 'clock'))
    s = await renewLicense().catch(() => s);
  if (s?.member) return true;
  askMembership(reason);
  return false;
}
// The same for a click that must act at once: false (and the dialog, if needed) unless a member.
export function memberNow(reason: string) {
  if (!isDesktop || status?.member) return true;
  void requireMember(reason);
  return false;
}
