/**
 * The `webhook` action: Timon calling another service.
 *
 * The call is a POST of `{type, timestamp, data}` (`data` = the payload the
 * trigger received, `type` = its event kind, or `webhook` / `schedule`),
 * signed the Standard Webhooks way with the trigger's OUTBOUND secret — never
 * the one that checks what it receives, or the receiver could forge calls to
 * us. Durable: the call waits in `trigger_outbox`, is tried at once, then
 * retried with back-off (1 min doubling, capped at 6 h) until 10 attempts.
 * The `webhook-id` and the bytes stay the same across retries, so the
 * receiver can deduplicate.
 *
 * Neither the secret nor the response body ever reaches a log or the journal:
 * only the status code or the error name.
 *
 * The URL is typed by a user, so the call goes through the SSRF guard
 * (`plugins/net-guard.ts`): public addresses only, judged after DNS
 * resolution, on the socket that actually connects. Never the cloud metadata
 * endpoint, loopback (the daemon's own API) nor the LAN.
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { db } from '../db.js';
import { classifyAddress, DestinationRefusedError, guardedFetch, type AddressLookup, type DestinationPolicy } from '../plugins/net-guard.js';
import { redactSecrets, redactSecretsDeep } from '../secrets/egress-guard.js';
import type { TriggerInput } from './payload.js';
import { signStandard } from './signature.js';
import { getTrigger, recordDelivery, type Trigger } from './store.js';

export const OUTBOX_MAX_ATTEMPTS = 10;
/** A payload bigger than this is refused at enqueue: the receiver is not a file store. */
export const OUTBOX_BODY_LIMIT = 256 * 1024;
const TIMEOUT_MS = 10_000;
/** Delivered rows kept this long, for inspection, then purged. */
const KEEP_DELIVERED_MS = 7 * 24 * 3600_000;
const BATCH = 20;

const backoffMs = (attempts: number) => Math.min(6 * 3600_000, 60_000 * 2 ** (attempts - 1));

/** Where a webhook may go: HTTPS towards a public address, nothing private. */
const OUTBOUND_POLICY: DestinationPolicy = Object.freeze({ allowPrivateNetwork: false });

/**
 * The HTTP client; tests swap `fetch` so nothing leaves the machine, or only
 * `lookup` to drive the guard without DNS.
 */
export const outboxTransport: { fetch: typeof fetch; lookup: AddressLookup | undefined } = {
  fetch: (input, init) => guardedFetch(input, init, { destination: () => OUTBOUND_POLICY, lookup: outboxTransport.lookup }),
  lookup: undefined,
};

/**
 * What can be refused without DNS: a host that is an IP literal outside the
 * public ranges, or a `localhost` name. A name that RESOLVES to such an
 * address is refused at delivery, by the guard. `null` = acceptable.
 */
export function webhookUrlRefusal(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return 'invalid URL'; }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'a webhook cannot target this machine';
  if (isIP(host) && classifyAddress(host) !== 'public') return `a webhook cannot target ${host}: only public addresses`;
  return null;
}

type OutboxRow = { id: string; trigger_id: string; url: string; body: string; attempts: number };

export function webhookEnvelope(trigger: Trigger, input: TriggerInput, now: number = Date.now()): string {
  const type = trigger.source === 'event' ? trigger.config.event : trigger.source;
  return JSON.stringify({ type, timestamp: new Date(now).toISOString(), data: input.body ?? null });
}

/** Redact credential values, parsing JSON so an escaped secret is still found. */
function redactJsonBody(body: string): string {
  try { return JSON.stringify(redactSecretsDeep(JSON.parse(body))); } catch { return redactSecrets(body); }
}

/** Queues one call and returns its `webhook-id`. Throws when it cannot be sent at all. */
export function enqueueWebhook(trigger: Trigger, url: string, body: string, now: number = Date.now()): string {
  if (!trigger.outboundSecret) throw new Error('no outbound secret: rotate it on the trigger');
  // No known credential leaves the daemon, even if a caller put one in the payload.
  body = redactJsonBody(body);
  if (Buffer.byteLength(body) > OUTBOX_BODY_LIMIT) throw new Error('payload too large for a webhook');
  // A row saved before the guard existed fails here, visibly, not ten times in the outbox.
  const refused = webhookUrlRefusal(url);
  if (refused) throw new Error(refused);
  const id = `msg_${randomUUID().replace(/-/g, '')}`;
  db.prepare(
    `INSERT INTO trigger_outbox (id, trigger_id, url, body, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, trigger.id, url, body, now, now);
  // Tried right away, out of the caller's write.
  setImmediate(() => { void deliverDueWebhooks().catch((err) => console.error('[triggers] webhook delivery:', (err as Error).message)); });
  return id;
}

let running = false;

/**
 * Sends the due calls. One run at a time: an overlapping tick returns at
 * once, so a call is never sent twice in parallel.
 */
export async function deliverDueWebhooks(now: () => number = Date.now): Promise<number> {
  if (running) return 0;
  running = true;
  let delivered = 0;
  try {
    db.prepare(`DELETE FROM trigger_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?`).run(now() - KEEP_DELIVERED_MS);
    const due = db.prepare(
      `SELECT id, trigger_id, url, body, attempts FROM trigger_outbox
        WHERE delivered_at IS NULL AND failed_at IS NULL AND next_at <= ? ORDER BY created_at LIMIT ?`,
    ).all(now(), BATCH) as OutboxRow[];
    for (const row of due) {
      // Re-read: the trigger may have been disabled, or its secret rotated.
      const trigger = getTrigger(row.trigger_id);
      if (!trigger || !trigger.enabled || !trigger.outboundSecret) {
        db.prepare(`UPDATE trigger_outbox SET failed_at = ?, last_error = ? WHERE id = ?`)
          .run(now(), trigger ? 'trigger disabled' : 'trigger deleted', row.id);
        continue;
      }
      const timestamp = Math.floor(now() / 1000);
      let error: string | null = null;
      try {
        const res = await outboxTransport.fetch(row.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'webhook-id': row.id,
            'webhook-timestamp': String(timestamp),
            'webhook-signature': signStandard(trigger.outboundSecret, row.id, timestamp, row.body),
          },
          body: row.body,
          // A redirect would carry the signed call somewhere the owner never named.
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) error = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        // The guard's message names the refused address, never a secret: the owner needs it to fix the URL.
        error = err instanceof DestinationRefusedError ? `refused: ${err.message}` : (err as Error).name || 'network error';
      }
      const attempts = row.attempts + 1;
      if (!error) {
        db.prepare(`UPDATE trigger_outbox SET delivered_at = ?, attempts = ?, last_error = NULL WHERE id = ?`).run(now(), attempts, row.id);
        delivered += 1;
        continue;
      }
      const failed = attempts >= OUTBOX_MAX_ATTEMPTS;
      db.prepare(`UPDATE trigger_outbox SET attempts = ?, next_at = ?, last_error = ?, failed_at = ? WHERE id = ?`)
        .run(attempts, now() + backoffMs(attempts), error, failed ? now() : null, row.id);
      if (failed) {
        recordDelivery({
          triggerId: trigger.id, status: 'error', deliveryKey: row.id,
          reason: `webhook: gave up after ${attempts} attempts (${error})`,
        });
      }
    }
  } finally {
    running = false;
  }
  return delivered;
}

/** Same cadence as the schedule tick. */
export const OUTBOX_TICK_MS = 30_000;

export function startWebhookOutbox(): () => void {
  const tick = () => {
    void deliverDueWebhooks().catch((err) => console.error('[triggers] webhook outbox tick:', (err as Error).message));
  };
  tick();
  const timer = setInterval(tick, OUTBOX_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
