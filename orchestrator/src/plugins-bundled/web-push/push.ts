/**
 * Native Web Push — a system notification on the phone when a decision is
 * waiting, without going through Telegram.
 *
 * ── Where sending lives, and why here ───────────────────────────────────────
 * Sending starts from the ORCHESTRATOR (the host daemon), not from the Next
 * app. The alternative "the orchestrator POSTs to the app, which pushes" was
 * ruled out:
 *   - the orchestrator already owns the database exclusively — subscriptions
 *     and the delivery trace live there, and purging a dead subscription (410)
 *     is a database write, so the app would need one more round trip per
 *     deletion;
 *   - `createNotification` is the single chokepoint, and it is here; routing
 *     through the app would add a network hop, an auth surface and one more
 *     failure mode (app down = no push while the orchestrator still runs);
 *   - the lifecycle (closing the notification once the permission is
 *     resolved) is driven by the event resolver, on the orchestrator side too.
 * The app keeps a single role: same-origin proxy of the subscription routes,
 * like every other `/api/ui/*` route.
 *
 * ── VAPID keys ──────────────────────────────────────────────────────────────
 * Never in the repository.
 *   TIMON_VAPID_PUBLIC_KEY   public key (base64url) — served to the browser;
 *                            env, then the setting of the same name
 *   TIMON_VAPID_PRIVATE_KEY  private key (base64url) — never leaves the host;
 *                            env (`~/.timon/secrets.env`), then the vault
 *   TIMON_VAPID_SUBJECT      `mailto:…` or service URL; env, then the setting
 *                            (default mailto:timon@localhost)
 * Generate the pair once: `node orchestrator/scripts/generate-vapid.mjs`.
 * Without the keys the whole module is inert (nothing sent, no loud error).
 */
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { dbApi, type NotificationRow, type PushSubscriptionRow } from '../../db.js';
import { redactSecretsDeep } from '../../secrets/egress-guard.js';
import { settingStr } from '../../settings.js';
import type { PushFanoutResult } from '../../notifications.js';
import { relayedMachineId } from '../../machines/relayed.js';
import { vaultEnabled } from '../../secrets/availability.js';
import { readSecretValue } from '../../secrets/store.js';

/**
 * The private key from the vault, where SECRETS.md tells the operator to put
 * it (`timon secret set TIMON_VAPID_PRIVATE_KEY --stdin`, no grant: daemon
 * only). The env still wins, so a key kept in `secrets.env` works unchanged.
 * Replaces the old fallback that read the repository's `.env` relative to the
 * process cwd: on an installed daemon that is whatever `.env` happens to sit
 * one level above its working directory.
 */
function vaultPrivateKey(): string {
  if (!vaultEnabled()) return '';
  for (const row of dbApi.getSecretsByName('TIMON_VAPID_PRIVATE_KEY')) {
    try {
      const value = readSecretValue(row.id).trim();
      if (value) return value;
    } catch { /* sealed under a key nobody holds any more: try the next row */ }
  }
  return '';
}

export type VapidKeys = { publicKey: string; privateKey: string; subject: string };

/** The VAPID material, or null when the pair is incomplete. */
export function resolveVapidKeys(): VapidKeys | null {
  const publicKey = (process.env.TIMON_VAPID_PUBLIC_KEY ?? settingStr('TIMON_VAPID_PUBLIC_KEY') ?? '').trim();
  const privateKey = process.env.TIMON_VAPID_PRIVATE_KEY?.trim() || vaultPrivateKey();
  if (!publicKey || !privateKey) return null;
  const subject = (process.env.TIMON_VAPID_SUBJECT ?? settingStr('TIMON_VAPID_SUBJECT') ?? '').trim() || 'mailto:timon@localhost';
  return { publicKey, privateKey, subject };
}

let configured: boolean | null = null;
let publicKey = '';

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const keys = resolveVapidKeys();
  if (!keys) {
    configured = false;
    console.log('[push] disabled — TIMON_VAPID_PUBLIC_KEY / TIMON_VAPID_PRIVATE_KEY missing');
    return false;
  }
  try {
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  } catch (err) {
    configured = false;
    console.warn('[push] invalid VAPID keys:', (err as Error).message);
    return false;
  }
  publicKey = keys.publicKey;
  configured = true;
  console.log('[push] active (VAPID configured)');
  return true;
}

export function isPushConfigured(): boolean {
  return ensureConfigured();
}

/** Public key served to the browser for `pushManager.subscribe()`. */
export function getVapidPublicKey(): string | null {
  return ensureConfigured() ? publicKey : null;
}

/**
 * A notification's deep link, RELATIVE to the origin.
 *
 * Source of truth for building the URL, shared between the rail
 * (app/src/lib/notification-href.ts, same logic on the client) and the push
 * payload. Relative rather than absolute on purpose: the service worker
 * resolves the URL against its own origin, so a subscription taken from
 * `timon.localhost` opens localhost and one taken from the tailnet opens the
 * tailnet — with no public-URL environment variable to keep up to date.
 */
export function notificationHref(n: Pick<NotificationRow, 'mission_id' | 'task_id' | 'anchor'>): string | null {
  const egress = n.anchor ? EGRESS_ANCHOR.exec(n.anchor) : null;
  if (egress) return `/chat?mission=${encodeURIComponent(egress[1]!)}&egress=1`;
  if (n.mission_id) {
    const anchor = n.anchor ? `&highlight=${encodeURIComponent(n.anchor)}` : '';
    return `/chat?mission=${encodeURIComponent(n.mission_id)}${anchor}`;
  }
  if (n.task_id) return `/chat?task=${encodeURIComponent(n.task_id)}`;
  if (n.anchor && n.anchor.startsWith('/')) return n.anchor;
  const consent = n.anchor ? PLUGIN_SECRET_ANCHOR.exec(n.anchor) : null;
  if (consent) return `/secrets?grant=${encodeURIComponent(consent[2]!)}&plugin=${encodeURIComponent(consent[1]!)}`;
  const launch = n.anchor ? PROVIDER_LAUNCH_ANCHOR.exec(n.anchor) : null;
  if (launch) return `/?settings=${encodeURIComponent('models/backends')}&provider=${encodeURIComponent(launch[1]!)}`;
  return null;
}

/**
 * A new outbound host for a mission (`egress/service.ts`, TODO #590): the card
 * opens the mission's chat with its Network view. Not `&highlight=`: that one
 * names a card of the thread, and the chat would page through the whole
 * history looking for it.
 */
const EGRESS_ANCHOR = /^egress:(.+)$/;

/**
 * A third-party launch refused because its program is not the file authorized
 * (`backends/launch-card.ts`, TODO #598): the card opens Settings › AI models ›
 * Backends on that provider, where the re-authorization is confirmed.
 */
const PROVIDER_LAUNCH_ANCHOR = /^provider-launch:(.+)$/;

/**
 * The consent card a plugin raises when a secret it asks for is only shared
 * `global` (`secrets/plugins.ts`, TODO #531/#597): it opens the Secrets page
 * with the grant pre-filled, for the operator to confirm. The anchor itself
 * stays as is — it is what closes the card once the grant exists. A secret
 * name never holds `:`, so the last one splits the plugin id from it.
 */
const PLUGIN_SECRET_ANCHOR = /^plugin-secret:(.+):([A-Z][A-Z0-9_]*)$/;

/**
 * Web Push tag: two notifications with the same tag REPLACE each other on the
 * device instead of piling up. Keyed on the anchor when there is one (= the
 * permission id, so one card = one system notification), otherwise on the
 * notification id.
 */
export function pushTag(n: Pick<NotificationRow, 'id' | 'anchor'>): string {
  return n.anchor ? `timon-anchor-${n.anchor}` : `timon-notif-${n.id}`;
}

export function pushTagForAnchor(anchor: string): string {
  return `timon-anchor-${anchor}`;
}

function toWebPushSubscription(row: PushSubscriptionRow): webpush.PushSubscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
}

/** 404/410 = the subscription no longer exists on the browser's push service.
 *  Keeping it would retry a dead endpoint forever, on every notification. */
function isGone(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

type SendResult = { status: 'sent' | 'gone' | 'failed'; error: string | null };

const EMPTY_FANOUT: PushFanoutResult = {
  configured: false, targeted: 0, delivered: 0, failed: 0, gone: 0, skipped: 0,
};

async function sendRaw(row: PushSubscriptionRow, payload: unknown): Promise<SendResult> {
  try {
    await webpush.sendNotification(toWebPushSubscription(row), JSON.stringify(redactSecretsDeep(payload)), { TTL: 900 });
    dbApi.setPushSubscriptionError(row.id, null);
    return { status: 'sent', error: null };
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    const label = row.device_label ?? row.id.slice(0, 8);
    if (isGone(e.statusCode)) {
      dbApi.deletePushSubscription(row.id);
      console.log(`[push] subscription purged (${e.statusCode}) — ${label}`);
      return { status: 'gone', error: null };
    }
    const detail = `${e.statusCode ?? '?'} ${e.message ?? 'unknown error'}`;
    dbApi.setPushSubscriptionError(row.id, detail);
    console.warn(`[push] send failed — ${label}: ${detail}`);
    return { status: 'failed', error: detail };
  }
}

/**
 * Fan-out of a notification to every subscribed device.
 *
 * Deliberately limited to `action_required`: `alert` and `report` would drown
 * the channel. The filter lives here (not with the caller) so it stays the
 * only place to change the day routing gets finer.
 */
export async function pushNotification(
  n: NotificationRow,
  opts?: {
    /**
     * Id of the permission that can be resolved INLINE from the notification
     * (Approve / Deny buttons). Set only when the decision really is a yes/no:
     * an `ask_user` card expects a form, two buttons would miss the point — it
     * stays a deep link only.
     */
    permissionId?: string | null;
  },
): Promise<PushFanoutResult> {
  if (n.type !== 'action_required') return { ...EMPTY_FANOUT };
  if (!ensureConfigured()) return { ...EMPTY_FANOUT };

  const subs = dbApi.listPushSubscriptions();
  const result: PushFanoutResult = {
    ...EMPTY_FANOUT, configured: true, targeted: subs.length,
  };
  if (subs.length === 0) return result;

  const payload = {
    kind: 'notification' as const,
    id: n.id,
    title: n.title,
    body: n.body ?? '',
    tag: pushTag(n),
    url: notificationHref(n),
    urgent: n.urgent === 1,
    permissionId: opts?.permissionId ?? null,
    // A card relayed from another machine of the fleet: the service worker
    // answers it and opens it on THAT machine, not on the active one.
    machineId: relayedMachineId(n.source),
  };

  await Promise.all(
    subs.map(async (sub) => {
      // Idempotent per (notification, subscription) PAIR: a device already
      // served is not notified again, a failing device does not stop the others.
      if (dbApi.wasPushDelivered(n.id, sub.id)) { result.skipped += 1; return; }
      const { status, error } = await sendRaw(sub, payload);
      if (status === 'gone') { result.gone += 1; return; } // row deleted, nothing to record
      if (status === 'sent') result.delivered += 1;
      else result.failed += 1;
      dbApi.recordPushDelivery(n.id, sub.id, status, error);
    }),
  );
  return result;
}

/**
 * Closes the notifications carrying this tag on the devices — called when the
 * permission is resolved or expires: the card is no longer actionable, leaving
 * it in the phone's drawer is only a false positive.
 * No delivery trace here: it is a transient order, not a notification.
 */
export async function pushCloseTag(tag: string): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = dbApi.listPushSubscriptions();
  if (subs.length === 0) return;
  const payload = { kind: 'close' as const, tag };
  await Promise.all(subs.map((sub) => sendRaw(sub, payload)));
}

/** A device subscription (POST from the browser, through the app's proxy). */
export function subscribeDevice(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel?: string | null;
}): PushSubscriptionRow {
  const existing = dbApi.getPushSubscriptionByEndpoint(input.endpoint);
  return dbApi.upsertPushSubscription({
    id: existing?.id ?? randomUUID(),
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    deviceLabel: input.deviceLabel ?? null,
  });
}

export function unsubscribeDevice(endpoint: string): boolean {
  return dbApi.deletePushSubscriptionByEndpoint(endpoint);
}
