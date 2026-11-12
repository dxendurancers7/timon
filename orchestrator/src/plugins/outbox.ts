/**
 * `ctx.outbox` — durable outgoing calls of third-party plugins.
 *
 * A connector that mirrors the notebook elsewhere (a Discord thread, a GitHub
 * issue) cannot afford a lost call: an outcome announced but never sent, a
 * closure sent before the outcome. `fetch` gives neither guarantee; the outbox
 * gives both:
 *
 *  - durable: the call is a row of `plugin_outbox`, tried at once, then again
 *    with back-off (1 min doubling, capped at 6 h) up to 10 attempts. A 4xx
 *    other than 408/425/429 is final: the receiver refused the call itself;
 *  - ordered: calls sharing a `key` leave in the order they were posted, the
 *    next one waiting until the previous one is delivered or given up on;
 *  - signed on demand, the Standard Webhooks way (`webhook-id` stable across
 *    attempts — it is the row id —, `webhook-timestamp`, `v1,` HMAC), with a
 *    vault secret granted to the plugin.
 *
 * No credential enters the queue: a signing key, an `Authorization` value or
 * a URL that carries its own token (a Discord webhook) is named by the vault
 * entry that holds it, and read again at each attempt — a rotated secret is
 * used by the next attempt. Neither a secret nor a response body reaches a
 * log, an error message or the row: only a status code or an error name.
 *
 * Only a LOADED plugin's calls leave (`attach`, tied to its context): a
 * disabled plugin's queue waits for it, untouched.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { redactSecretsDeep } from '../secrets/egress-guard.js';
import { signStandard } from '../triggers/signature.js';

import type {
  PluginOutboxTarget, PluginOutboxOptions, PluginOutboxEntry, PluginOutboxErrorCode,
} from './contract/outbox.js';
export type {
  PluginOutboxMethod, PluginOutboxTarget, PluginOutboxOptions, PluginOutboxEntry, PluginOutboxErrorCode,
} from './contract/outbox.js';

export const PLUGIN_OUTBOX_MAX_ATTEMPTS = 10;
/** A body bigger than this is refused at post: the receiver is not a file store. */
export const PLUGIN_OUTBOX_BODY_LIMIT = 256 * 1024;
/** Calls waiting per plugin. Beyond, `post` refuses: a dead receiver must not
 *  fill the daemon's database. */
export const PLUGIN_OUTBOX_PENDING_LIMIT = 1000;
const TIMEOUT_MS = 10_000;
const KEEP_FINISHED_MS = 7 * 24 * 3600_000;
const BATCH = 20;
const TICK_MS = 30_000;

const backoffMs = (attempts: number) => Math.min(6 * 3600_000, 60_000 * 2 ** (attempts - 1));

export class PluginOutboxError extends Error {
  constructor(message: string, readonly code: PluginOutboxErrorCode) {
    super(message);
    this.name = 'PluginOutboxError';
  }
}

/** The binding `PluginHost.outbox`. */
export type PluginOutboxHost = {
  enqueue(pluginId: string, target: PluginOutboxTarget, body: unknown, opts: PluginOutboxOptions): string;
  get(pluginId: string, id: string): PluginOutboxEntry | undefined;
  /** The plugin is loaded: its calls may leave. Returns the detacher. */
  attach(pluginId: string): () => void;
};

export type PluginOutboxDeps = {
  fetch: typeof globalThis.fetch;
  /** A vault entry granted to the plugin, or `undefined`. */
  secret(pluginId: string, name: string): string | undefined;
  /** Throws when the operator's policy refuses the URL (`assertFetchAllowed`). */
  allow(pluginId: string, url: string): void;
  now?: () => number;
  /** Try at once and every 30 s. Off in tests that drive `deliverDue`. */
  schedule?: boolean;
};

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Set by the outbox itself, or carrying a credential. */
const RESERVED_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'content-type',
  'transfer-encoding', 'connection', 'webhook-id', 'webhook-timestamp', 'webhook-signature',
]);
const secretName = z.string().trim().min(1).max(128);

const optionsSchema = z.object({
  key: z.string().min(1).max(200).optional(),
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(
    z.string().regex(HEADER_NAME).refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), 'reserved header'),
    z.string().max(1024).refine((v) => !/[\r\n]/.test(v), 'line break in header value'),
  ).refine((h) => Object.keys(h).length <= 20, 'at most 20 headers').optional(),
  sign: z.object({ secret: secretName }).strict().optional(),
  auth: z.object({
    secret: secretName,
    header: z.string().regex(HEADER_NAME)
      .refine((n) => n.toLowerCase() === 'authorization' || !RESERVED_HEADERS.has(n.toLowerCase()), 'reserved header')
      .optional(),
    /** `''` = the raw value, no scheme. */
    scheme: z.union([z.literal(''), z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,31}$/)]).optional(),
  }).strict().optional(),
}).strict();

const targetSchema = z.union([z.string().min(1).max(2048), z.object({ secret: secretName }).strict()]);

type Row = {
  seq: number; id: string; plugin_id: string; key: string | null; method: string;
  url: string | null; url_secret: string | null; headers: string; body: string | null;
  sign_secret: string | null; auth_secret: string | null; auth_header: string | null; auth_scheme: string | null;
  attempts: number; delivered_at: number | null; failed_at: number | null; last_error: string | null; created_at: number;
};

function entryOf(row: Row): PluginOutboxEntry {
  return {
    id: row.id, key: row.key,
    state: row.delivered_at !== null ? 'delivered' : row.failed_at !== null ? 'failed' : 'pending',
    attempts: row.attempts, last_error: row.last_error, created_at: row.created_at,
    delivered_at: row.delivered_at, failed_at: row.failed_at,
  };
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ');
}

/** A 4xx the receiver means: the same call will be refused again. */
const finalStatus = (status: number) => status >= 400 && status < 500 && ![408, 425, 429].includes(status);

export function createPluginOutbox(deps: PluginOutboxDeps): PluginOutboxHost & { deliverDue(): Promise<number> } {
  const now = deps.now ?? Date.now;
  const attached = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const kick = () => {
    if (!deps.schedule) return;
    setImmediate(() => { void deliverDue().catch((err) => console.error('[plugins] outbox delivery:', (err as Error).name)); });
  };

  const needSecret = (pluginId: string, name: string, what: string): string => {
    const value = deps.secret(pluginId, name);
    if (value === undefined) throw new PluginOutboxError(`${what}: secret \`${name}\` is not granted to this plugin`, 'secret_missing');
    return value;
  };

  function enqueue(pluginId: string, target: PluginOutboxTarget, body: unknown, opts: PluginOutboxOptions): string {
    const t = targetSchema.safeParse(target);
    if (!t.success) throw new PluginOutboxError(`invalid target: ${issues(t.error)}`, 'invalid');
    const o = optionsSchema.safeParse(opts ?? {});
    if (!o.success) throw new PluginOutboxError(`invalid options: ${issues(o.error)}`, 'invalid');
    const options = o.data;

    let url: string | null = null;
    let urlSecret: string | null = null;
    if (typeof t.data === 'string') {
      try { deps.allow(pluginId, t.data); } catch (err) {
        throw new PluginOutboxError((err as Error).message, 'not_allowed');
      }
      url = t.data;
    } else {
      urlSecret = t.data.secret;
      const held = needSecret(pluginId, urlSecret, 'target');
      // The URL is the secret: say which entry is refused, never what it holds.
      try { deps.allow(pluginId, held); } catch {
        throw new PluginOutboxError(`target: the URL held by secret \`${urlSecret}\` is not allowed by pluginPolicy.http`, 'not_allowed');
      }
    }
    if (options.sign) needSecret(pluginId, options.sign.secret, 'sign');
    if (options.auth) needSecret(pluginId, options.auth.secret, 'auth');

    let serialized: string | null = null;
    if (body !== undefined) {
      // Redact the PARSED value, not the serialized string: a credential in a
      // string field is found (even one containing quotes/newlines) and a number
      // that happens to equal a secret is never rewritten into invalid JSON.
      try { serialized = JSON.stringify(redactSecretsDeep(body)); } catch {
        throw new PluginOutboxError('body is not JSON-serialisable', 'invalid');
      }
      if (serialized === undefined) throw new PluginOutboxError('body is not JSON-serialisable', 'invalid');
      if (Buffer.byteLength(serialized) > PLUGIN_OUTBOX_BODY_LIMIT) {
        throw new PluginOutboxError(`body larger than ${PLUGIN_OUTBOX_BODY_LIMIT} bytes`, 'invalid');
      }
    }
    const pending = (db.prepare(
      `SELECT COUNT(*) n FROM plugin_outbox WHERE plugin_id = ? AND delivered_at IS NULL AND failed_at IS NULL`,
    ).get(pluginId) as { n: number }).n;
    if (pending >= PLUGIN_OUTBOX_PENDING_LIMIT) {
      throw new PluginOutboxError(`${PLUGIN_OUTBOX_PENDING_LIMIT} calls already waiting for this plugin`, 'full');
    }

    const authHeader = options.auth ? (options.auth.header ?? 'authorization').toLowerCase() : null;
    const id = `msg_${randomUUID().replace(/-/g, '')}`;
    const at = now();
    db.prepare(`
      INSERT INTO plugin_outbox (id, plugin_id, key, method, url, url_secret, headers, body, sign_secret,
        auth_secret, auth_header, auth_scheme, attempts, next_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id, pluginId, options.key ?? null, options.method ?? 'POST', url, urlSecret,
      JSON.stringify(options.headers ?? {}), serialized, options.sign?.secret ?? null,
      options.auth?.secret ?? null, authHeader,
      options.auth ? (options.auth.scheme ?? (authHeader === 'authorization' ? 'Bearer' : '')) || null : null,
      at, at,
    );
    kick();
    return id;
  }

  /** The call of one row, or the reason it cannot be built (retryable). */
  function request(row: Row, timestamp: number): { url: string; init: RequestInit } | { error: string; final: boolean } {
    const url = row.url ?? (row.url_secret ? deps.secret(row.plugin_id, row.url_secret) : undefined);
    if (url === undefined) return { error: 'target secret unavailable', final: false };
    // Re-checked: the operator may have narrowed the policy since the post.
    try { deps.allow(row.plugin_id, url); } catch { return { error: 'host not allowed by pluginPolicy.http', final: true }; }
    const headers: Record<string, string> = { ...(JSON.parse(row.headers) as Record<string, string>) };
    if (row.body !== null) headers['content-type'] = 'application/json';
    if (row.auth_secret) {
      const value = deps.secret(row.plugin_id, row.auth_secret);
      if (value === undefined) return { error: 'auth secret unavailable', final: false };
      headers[row.auth_header ?? 'authorization'] = row.auth_scheme ? `${row.auth_scheme} ${value}` : value;
    }
    if (row.sign_secret) {
      const key = deps.secret(row.plugin_id, row.sign_secret);
      if (key === undefined) return { error: 'signing secret unavailable', final: false };
      headers['webhook-id'] = row.id;
      headers['webhook-timestamp'] = String(timestamp);
      headers['webhook-signature'] = signStandard(key, row.id, timestamp, row.body ?? '');
    }
    return {
      url,
      init: {
        method: row.method, headers, body: row.body ?? undefined,
        // A redirect would carry the call (and its credential) elsewhere.
        redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    };
  }

  async function deliverOne(row: Row): Promise<boolean> {
    const built = request(row, Math.floor(now() / 1000));
    let error: string | null = null;
    let final = false;
    if ('error' in built) {
      ({ error, final } = built);
    } else {
      try {
        const res = await deps.fetch(built.url, built.init);
        if (!res.ok) { error = `HTTP ${res.status}`; final = finalStatus(res.status); }
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        error = (err as Error).name || 'network error';
      }
    }
    const attempts = row.attempts + 1;
    if (!error) {
      db.prepare(`UPDATE plugin_outbox SET delivered_at = ?, attempts = ?, last_error = NULL WHERE seq = ?`).run(now(), attempts, row.seq);
      return true;
    }
    const failed = final || attempts >= PLUGIN_OUTBOX_MAX_ATTEMPTS;
    db.prepare(`UPDATE plugin_outbox SET attempts = ?, next_at = ?, last_error = ?, failed_at = ? WHERE seq = ?`)
      .run(attempts, now() + backoffMs(attempts), error, failed ? now() : null, row.seq);
    if (failed) console.warn(`[plugin:${row.plugin_id}] outbox: gave up on ${row.id} after ${attempts} attempt(s) (${error})`);
    return false;
  }

  /**
   * Sends the due calls of the loaded plugins. One run at a time. A call
   * whose key has an earlier call still waiting is not due, whatever its
   * `next_at`: that is the whole ordering guarantee.
   */
  async function deliverDue(): Promise<number> {
    if (running || attached.size === 0) return 0;
    running = true;
    let delivered = 0;
    try {
      db.prepare(`DELETE FROM plugin_outbox WHERE COALESCE(delivered_at, failed_at) < ?`).run(now() - KEEP_FINISHED_MS);
      const select = db.prepare(`
        SELECT o.* FROM plugin_outbox o
         WHERE o.delivered_at IS NULL AND o.failed_at IS NULL AND o.next_at <= ?
           AND o.plugin_id IN (SELECT value FROM json_each(?))
           AND (o.key IS NULL OR NOT EXISTS (
             SELECT 1 FROM plugin_outbox p
              WHERE p.plugin_id = o.plugin_id AND p.key = o.key AND p.seq < o.seq
                AND p.delivered_at IS NULL AND p.failed_at IS NULL))
         ORDER BY o.seq LIMIT ?`);
      // A delivered call frees the next one of its key: go round again, so
      // an outcome and its closure leave in the same run.
      for (let round = 0; round < 10; round++) {
        const due = select.all(now(), JSON.stringify([...attached.keys()]), BATCH) as Row[];
        let progressed = false;
        for (const row of due) {
          if (await deliverOne(row)) { delivered += 1; progressed = true; }
        }
        if (!progressed) break;
      }
    } finally {
      running = false;
    }
    return delivered;
  }

  return {
    enqueue,
    get(pluginId, id) {
      const row = db.prepare(`SELECT * FROM plugin_outbox WHERE plugin_id = ? AND id = ?`).get(pluginId, id) as Row | undefined;
      return row ? entryOf(row) : undefined;
    },
    attach(pluginId) {
      attached.set(pluginId, (attached.get(pluginId) ?? 0) + 1);
      if (deps.schedule && !timer) {
        timer = setInterval(() => { void deliverDue().catch((err) => console.error('[plugins] outbox tick:', (err as Error).name)); }, TICK_MS);
        timer.unref();
      }
      kick();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = (attached.get(pluginId) ?? 1) - 1;
        if (n > 0) attached.set(pluginId, n); else attached.delete(pluginId);
        if (attached.size === 0 && timer) { clearInterval(timer); timer = null; }
      };
    },
    deliverDue,
  };
}
