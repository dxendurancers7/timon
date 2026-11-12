/**
 * The generic verifier of plugin webhooks: a signature scheme is a
 * DESCRIPTION (data, never code) checked by `WebhookSchemeSchema`, and one
 * engine verifies every description. GitHub, Stripe, Slack… are entries of
 * `webhook-formats.ts`, not branches of a switch.
 *
 * Three kinds, nothing else — there is no `none`:
 *   hmac     HMAC-SHA256/SHA1 over a signed template that always contains
 *            `{body}`, hex or base64, optional prefix, optional timestamp.
 *   token    a shared token compared in constant time (GitLab). Weak: whoever
 *            captured one request holds the token and can forge any body.
 *   ed25519  a public key verifies a signature (Discord interactions).
 *
 * What a description cannot do, by construction of the schema:
 *   - sign without the body (`{body}` exactly once in the template);
 *   - declare a timestamp the signature does not cover, or one without a
 *     window and a unit;
 *   - name a header the app relay drops or that carries a browser credential;
 *   - accept a short secret (floor of 16 characters).
 *
 * The secret never leaves the daemon: the engine receives it, computes, and
 * returns only a verdict plus keys derived from what it authenticated.
 *
 * Replay keys follow `triggers/signature.ts`: the first one derives from what
 * the secret authenticated (the digest of the signed message), so a captured
 * request replayed with a changed delivery header is still caught. The id of
 * the delivery — a signed header, else the declared delivery header, else the
 * body's fingerprint — is claimed with it, so the sender's honest retries
 * (which re-sign with a fresh timestamp: Stripe, Slack) are deduplicated too.
 */
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifySignatureBytes, type KeyObject } from 'node:crypto';
import { z } from 'zod';

// ── the description ─────────────────────────────────────────────────────────

/**
 * Headers a description may not name: the app relay drops them before the
 * daemon sees the call (`app/src/lib/trigger-hook-relay.ts`), or they carry a
 * credential of the browser or of the daemon, never of a sender.
 */
const RESERVED_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length',
  'content-type', 'expect', 'cookie', 'authorization', 'proxy-authorization', 'proxy-connection', 'forwarded',
  'x-real-ip',
]);

export const SchemeHeaderSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'a header name, lowercase (`x-hub-signature-256`)')
  .refine((name) => !RESERVED_HEADERS.has(name) && !name.startsWith('x-forwarded-') && !name.startsWith('x-timon-'),
    'this header never reaches the daemon or carries a credential that is not the sender\'s');

/** Above this, a skewed clock is no longer the reason: the window is a replay budget. */
const MAX_WINDOW_S = 900;
const TimestampUnitSchema = z.enum(['s', 'ms']);
const WindowSchema = z.number().int().min(1).max(MAX_WINDOW_S);

const TimestampSchema = z.discriminatedUnion('from', [
  /** A header whose value the template signs (`{timestamp}`). */
  z.strictObject({ from: z.literal('header'), header: SchemeHeaderSchema, unit: TimestampUnitSchema, windowS: WindowSchema }),
  /** The `t=` of a keyed signature header (Stripe), signed through `{timestamp}`. */
  z.strictObject({ from: z.literal('signature'), unit: TimestampUnitSchema, windowS: WindowSchema }),
  /** A top-level field of the JSON body, signed with it (Linear's `webhookTimestamp`). */
  z.strictObject({
    from: z.literal('json'),
    field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'a top-level JSON field name'),
    unit: TimestampUnitSchema,
    windowS: WindowSchema,
  }),
]);

const PrefixSchema = z.string().max(16).regex(/^[\x21-\x7e]*$/, 'printable ASCII, no space');

const SignatureSchema = z.discriminatedUnion('format', [
  /** One signature: `sha256=<hex>`, `v0=<hex>`, `<hex>`. */
  z.strictObject({ format: z.literal('single'), header: SchemeHeaderSchema, prefix: PrefixSchema.default('') }),
  /** Space-separated candidates, each with the prefix (`v1,<b64> v1,<b64>`). */
  z.strictObject({ format: z.literal('list'), header: SchemeHeaderSchema, prefix: PrefixSchema.min(1) }),
  /** `t=<ts>,v1=<sig>,v1=<sig>` (Stripe): `key` names the signatures, others are ignored. */
  z.strictObject({
    format: z.literal('keyed'),
    header: SchemeHeaderSchema,
    key: z.string().regex(/^[a-z0-9]{1,8}$/),
    timestampKey: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  }),
]);

const TemplateSchema = z.string().min(6).max(200);
const DeliverySchema = z.strictObject({ header: SchemeHeaderSchema });

/** Floor of every shared secret, whatever the description says. */
export const MIN_SECRET_LENGTH = 16;
const SecretSchema = z.strictObject({
  /** `generated`: the host makes it and the sender is given it; `provided`: the sender makes it, it is pasted. */
  sources: z.array(z.enum(['generated', 'provided'])).min(1).max(2),
  minLength: z.number().int().min(MIN_SECRET_LENGTH).max(256),
  /** A provided secret must look like this (`^whsec_`): a pasted value of the wrong service is caught here. */
  pattern: z.string().max(120).optional(),
});

/**
 * An exchange the host answers by itself, after the signature, without the
 * plugin: Slack's `url_verification` echoes `challenge`, a Discord `PING`
 * gets `{"type":1}`. Nothing is claimed and no plugin code runs.
 */
const HandshakeSchema = z.strictObject({
  when: z.strictObject({
    field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    equals: z.union([z.string().max(64), z.number().int()]),
  }),
  reply: z.union([
    z.strictObject({ echo: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/) }),
    z.strictObject({ json: z.record(z.string(), z.union([z.string().max(64), z.number().int(), z.boolean()])) }),
  ]),
});

const QueryParamSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,31}$/);

/**
 * A subscription confirmed by a GET before any event (Meta: `hub.mode`,
 * `hub.verify_token`, `hub.challenge`). The host answers it alone, only with
 * the exact verify token, which it derives from the secret (`verifyTokenOf`):
 * nothing more to store, and a new secret gives a new token.
 */
const SubscribeSchema = z.strictObject({
  modeParam: QueryParamSchema,
  mode: z.string().regex(/^[a-z]{1,32}$/),
  tokenParam: QueryParamSchema,
  challengeParam: QueryParamSchema,
});

const HmacSchemeSchema = z.strictObject({
  kind: z.literal('hmac'),
  algorithm: z.enum(['sha256', 'sha512']),
  encoding: z.enum(['hex', 'base64']),
  /** `whsec`: Standard Webhooks key, `whsec_<base64>` decoded; `utf8`: the secret's bytes as is. */
  key: z.enum(['utf8', 'whsec']).default('utf8'),
  signature: SignatureSchema,
  signed: TemplateSchema,
  timestamp: TimestampSchema.optional(),
  delivery: DeliverySchema.optional(),
  secret: SecretSchema,
  handshakes: z.array(HandshakeSchema).max(4).optional(),
  subscribe: SubscribeSchema.optional(),
});

const TokenSchemeSchema = z.strictObject({
  kind: z.literal('token'),
  header: SchemeHeaderSchema,
  prefix: PrefixSchema.default(''),
  delivery: DeliverySchema.optional(),
  secret: SecretSchema,
});

const Ed25519SchemeSchema = z.strictObject({
  kind: z.literal('ed25519'),
  signature: z.strictObject({ header: SchemeHeaderSchema, encoding: z.enum(['hex', 'base64']) }),
  signed: TemplateSchema,
  timestamp: TimestampSchema.optional(),
  delivery: DeliverySchema.optional(),
  /** The public key the service shows, 32 bytes. */
  publicKey: z.strictObject({ encoding: z.enum(['hex', 'base64']) }),
  handshakes: z.array(HandshakeSchema).max(4).optional(),
});

type TemplatePart = { kind: 'text'; value: string } | { kind: 'body' } | { kind: 'timestamp' } | { kind: 'header'; name: string };

/** `{body}`, `{timestamp}`, `{header:<name>}` and literal text; anything else in braces is refused. */
export function parseTemplate(template: string): TemplatePart[] | string {
  const parts: TemplatePart[] = [];
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  for (let match = re.exec(template); match; match = re.exec(template)) {
    if (match.index > last) parts.push({ kind: 'text', value: template.slice(last, match.index) });
    const token = match[1] ?? '';
    if (token === 'body') parts.push({ kind: 'body' });
    else if (token === 'timestamp') parts.push({ kind: 'timestamp' });
    else if (token.startsWith('header:') && SchemeHeaderSchema.safeParse(token.slice('header:'.length)).success) {
      parts.push({ kind: 'header', name: token.slice('header:'.length) });
    } else return `unknown placeholder \`{${token}}\``;
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push({ kind: 'text', value: template.slice(last) });
  if (parts.some((p) => p.kind === 'text' && /[{}]/.test(p.value))) return 'unbalanced brace in the template';
  if (parts.filter((p) => p.kind === 'body').length !== 1) return 'the signed template must contain `{body}` exactly once';
  if (parts.filter((p) => p.kind === 'timestamp').length > 1) return '`{timestamp}` may appear once';
  return parts;
}

type SignedSchemeShape = { signed: string; timestamp?: z.infer<typeof TimestampSchema>; signature: unknown };

function checkSigned(scheme: SignedSchemeShape, ctx: z.RefinementCtx): void {
  const parts = parseTemplate(scheme.signed);
  if (typeof parts === 'string') { ctx.addIssue({ code: 'custom', path: ['signed'], message: parts }); return; }
  const signsTimestamp = parts.some((p) => p.kind === 'timestamp');
  const from = scheme.timestamp?.from;
  if (signsTimestamp && !scheme.timestamp) {
    ctx.addIssue({ code: 'custom', path: ['signed'], message: '`{timestamp}` needs a `timestamp` declaration (source, unit, window)' });
  }
  // A timestamp outside the signed bytes protects nothing: anyone can rewrite it.
  if ((from === 'header' || from === 'signature') && !signsTimestamp) {
    ctx.addIssue({ code: 'custom', path: ['timestamp'], message: 'a header timestamp must be signed: put `{timestamp}` in the template' });
  }
  if (from === 'json' && signsTimestamp) {
    ctx.addIssue({ code: 'custom', path: ['timestamp'], message: 'a JSON timestamp is signed with the body: no `{timestamp}` in the template' });
  }
  const keyed = (scheme.signature as { format?: string }).format === 'keyed';
  if (from === 'signature' && !keyed) {
    ctx.addIssue({ code: 'custom', path: ['timestamp'], message: '`from: signature` needs a `keyed` signature header' });
  }
  if (from === 'signature' && keyed && !(scheme.signature as { timestampKey?: string }).timestampKey) {
    ctx.addIssue({ code: 'custom', path: ['signature', 'timestampKey'], message: '`from: signature` needs `timestampKey`' });
  }
}

/**
 * The closed contract of a scheme description. `strictObject` everywhere: a
 * misspelt key (`timestmap`) would otherwise silently drop a protection.
 */
export const WebhookSchemeSchema = z.discriminatedUnion('kind', [HmacSchemeSchema, TokenSchemeSchema, Ed25519SchemeSchema])
  .superRefine((scheme, ctx) => {
    if (scheme.kind === 'token') return;
    checkSigned(scheme, ctx);
    if (scheme.kind === 'hmac' && scheme.secret.pattern !== undefined) {
      try { new RegExp(scheme.secret.pattern); } catch {
        ctx.addIssue({ code: 'custom', path: ['secret', 'pattern'], message: 'not a regular expression' });
      }
    }
  });
export type WebhookScheme = z.infer<typeof WebhookSchemeSchema>;

// ── what a scheme is worth ──────────────────────────────────────────────────

/**
 * Shown next to each webhook, strongest first:
 *   strong       signature covers a timestamp checked against a window;
 *   signed       signature over the body, the sender declares a delivery id;
 *   signed-body  signature over the body, replays caught by its fingerprint
 *                only (two identical bodies are one delivery);
 *   weak         shared token: no signature at all.
 */
export type WebhookSchemeLevel = 'strong' | 'signed' | 'signed-body' | 'weak';

export function schemeLevel(scheme: WebhookScheme): WebhookSchemeLevel {
  if (scheme.kind === 'token') return 'weak';
  if (scheme.timestamp) return 'strong';
  const parts = parseTemplate(scheme.signed);
  const signsHeader = Array.isArray(parts) && parts.some((p) => p.kind === 'header');
  return signsHeader || scheme.delivery ? 'signed' : 'signed-body';
}

/** The headers that carry the proof: never handed to the plugin. */
export function proofHeaders(scheme: WebhookScheme): string[] {
  return scheme.kind === 'token' ? [scheme.header] : [scheme.signature.header];
}

// ── secrets ──────────────────────────────────────────────────────────────────

/** Why a pasted value is refused, `null` when the scheme accepts it. Never echoes the value. */
export function invalidSecret(scheme: WebhookScheme, value: string): string | null {
  if (scheme.kind === 'ed25519') {
    return publicKeyOf(scheme, value) ? null : `expected a 32-byte Ed25519 public key in ${scheme.publicKey.encoding}`;
  }
  if (value.length < scheme.secret.minLength) return `too short: at least ${scheme.secret.minLength} characters`;
  if (value.length > 512) return 'too long';
  if (/\s/.test(value)) return 'must not contain spaces or line breaks';
  if (scheme.secret.pattern && !new RegExp(scheme.secret.pattern).test(value)) return 'does not look like a secret of this service';
  if (scheme.kind === 'hmac' && scheme.key === 'whsec' && hmacKey(scheme, value).length < 16) return 'the decoded key is too short';
  return null;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyOf(scheme: Extract<WebhookScheme, { kind: 'ed25519' }>, value: string): KeyObject | null {
  const strict = scheme.publicKey.encoding === 'hex' ? /^[0-9a-fA-F]{64}$/ : /^[A-Za-z0-9+/]{43}=$/;
  if (!strict.test(value)) return null;
  const raw = Buffer.from(value, scheme.publicKey.encoding);
  if (raw.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch { return null; }
}

function hmacKey(scheme: Extract<WebhookScheme, { kind: 'hmac' }>, secret: string): Buffer {
  return scheme.key === 'whsec' && secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
}

// ── verification ─────────────────────────────────────────────────────────────

export type SchemeVerdict =
  | {
    ok: true;
    /** Signed header, else the declared delivery header, else `sha256:<body digest>`. */
    id: string;
    idSource: 'signed' | 'delivery' | 'body';
    /** The verified timestamp, in milliseconds; `null` when the scheme signs none. */
    timestampMs: number | null;
    /** Claimed together by the replay guard. */
    replayKeys: string[];
  }
  | { ok: false; reason: 'missing_signature' | 'bad_signature' | 'stale_timestamp' };

/** A header value longer than this is not a signature: refused before any HMAC. */
const MAX_PROOF_HEADER = 2048;
const MAX_CANDIDATES = 8;
const MAX_DELIVERY_ID = 200;

function sha256(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant time whatever the lengths: both sides are hashed first. */
function safeEqual(expected: string | Buffer, given: string | Buffer): boolean {
  return timingSafeEqual(sha256(expected), sha256(given));
}

type Extracted = { candidates: string[]; keyedTimestamp: string | null } | null;

/**
 * Strict parsing: a malformed header is a missing signature, never a partial
 * read. Candidates keep their exact case and spacing; the comparison decides.
 */
function extractCandidates(signature: z.infer<typeof SignatureSchema>, value: string): Extracted {
  switch (signature.format) {
    case 'single':
      if (!value.startsWith(signature.prefix)) return null;
      return { candidates: [value.slice(signature.prefix.length)], keyedTimestamp: null };
    case 'list': {
      const items = value.split(' ');
      if (items.length > MAX_CANDIDATES || items.some((item) => !item)) return null;
      // A candidate of another version (`v2,…`) is skipped, not an error: the
      // format plans for it, and it never matches a `v1` anyway.
      const candidates = items.filter((item) => item.startsWith(signature.prefix)).map((item) => item.slice(signature.prefix.length));
      return candidates.length ? { candidates, keyedTimestamp: null } : null;
    }
    case 'keyed': {
      const items = value.split(',');
      if (items.length > MAX_CANDIDATES + 2) return null;
      const candidates: string[] = [];
      let timestamp: string | null = null;
      for (const item of items) {
        const at = item.indexOf('=');
        if (at <= 0) return null;
        const key = item.slice(0, at);
        const val = item.slice(at + 1);
        if (!/^[a-z0-9]{1,8}$/.test(key) || !val || /[\s=,]/.test(val)) return null;
        if (key === signature.timestampKey) {
          if (timestamp !== null) return null; // two `t=`: which one is signed?
          timestamp = val;
        } else if (key === signature.key) candidates.push(val);
      }
      if (!candidates.length || candidates.length > MAX_CANDIDATES) return null;
      if (signature.timestampKey && timestamp === null) return null;
      return { candidates, keyedTimestamp: timestamp };
    }
  }
}

function signedBytes(parts: TemplatePart[], body: Buffer, timestamp: string | null, headers: Record<string, string>): Buffer | null {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.kind === 'text') chunks.push(Buffer.from(part.value, 'utf8'));
    else if (part.kind === 'body') chunks.push(body);
    else if (part.kind === 'timestamp') {
      if (timestamp === null) return null;
      chunks.push(Buffer.from(timestamp, 'utf8'));
    } else {
      const value = headers[part.name];
      if (value === undefined || value.length > MAX_DELIVERY_ID) return null;
      chunks.push(Buffer.from(value, 'utf8'));
    }
  }
  return Buffer.concat(chunks);
}

function rawTimestamp(scheme: { timestamp?: z.infer<typeof TimestampSchema> }, headers: Record<string, string>, keyed: string | null): string | null {
  const from = scheme.timestamp?.from;
  if (from === 'header') return headers[(scheme.timestamp as { header: string }).header] ?? null;
  if (from === 'signature') return keyed;
  return null;
}

/** Milliseconds of a verified timestamp, `null` when it is missing or malformed. */
function timestampMs(scheme: { timestamp?: z.infer<typeof TimestampSchema> }, raw: string | null, body: Buffer): number | null {
  const declared = scheme.timestamp;
  if (!declared) return null;
  let value: number;
  if (declared.from === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
    const field = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)[declared.field] : undefined;
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) return null;
    value = field;
  } else {
    if (raw === null || !/^\d{1,16}$/.test(raw)) return null;
    value = Number(raw);
  }
  return declared.unit === 's' ? value * 1000 : value;
}

function deliveryId(scheme: WebhookScheme, parts: TemplatePart[] | null, headers: Record<string, string>, body: Buffer):
  { id: string; idSource: 'signed' | 'delivery' | 'body' } {
  const valid = (v: string | undefined): v is string => v !== undefined && v.length > 0 && v.length <= MAX_DELIVERY_ID && /^[\x21-\x7e]+$/.test(v);
  const signedHeader = parts?.find((p): p is { kind: 'header'; name: string } => p.kind === 'header');
  if (signedHeader && valid(headers[signedHeader.name])) return { id: headers[signedHeader.name] as string, idSource: 'signed' };
  const declared = scheme.delivery ? headers[scheme.delivery.header] : undefined;
  if (valid(declared)) return { id: declared, idSource: 'delivery' };
  return { id: `sha256:${sha256(body).toString('hex')}`, idSource: 'body' };
}

/**
 * Verifies one call against one description. Order: proof present and well
 * formed → signature → freshness. The signature is checked BEFORE the
 * timestamp: an unsigned request learns nothing about the window.
 */
export function verifyWithScheme(
  scheme: WebhookScheme,
  secret: string,
  body: Buffer,
  headers: Record<string, string>,
  nowMs: number = Date.now(),
): SchemeVerdict {
  if (scheme.kind === 'token') {
    const given = headers[scheme.header];
    if (given === undefined || given.length > MAX_PROOF_HEADER || !given.startsWith(scheme.prefix)) {
      return { ok: false, reason: 'missing_signature' };
    }
    if (!safeEqual(secret, given.slice(scheme.prefix.length))) return { ok: false, reason: 'bad_signature' };
    const { id, idSource } = deliveryId(scheme, null, headers, body);
    return { ok: true, id, idSource, timestampMs: null, replayKeys: [`id:${id}`] };
  }

  const parts = parseTemplate(scheme.signed);
  if (typeof parts === 'string') return { ok: false, reason: 'bad_signature' }; // the schema forbids it
  const value = headers[scheme.signature.header];
  if (value === undefined || value.length === 0 || value.length > MAX_PROOF_HEADER) return { ok: false, reason: 'missing_signature' };

  let candidates: string[];
  let keyed: string | null = null;
  if (scheme.kind === 'hmac') {
    const extracted = extractCandidates(scheme.signature, value);
    if (!extracted) return { ok: false, reason: 'missing_signature' };
    candidates = extracted.candidates;
    keyed = extracted.keyedTimestamp;
  } else {
    candidates = [value];
  }

  const raw = rawTimestamp(scheme, headers, keyed);
  if ((scheme.timestamp?.from === 'header' || scheme.timestamp?.from === 'signature') && raw === null) {
    return { ok: false, reason: 'missing_signature' };
  }
  const message = signedBytes(parts, body, raw, headers);
  if (!message) return { ok: false, reason: 'missing_signature' };

  if (scheme.kind === 'hmac') {
    const expected = createHmac(scheme.algorithm, hmacKey(scheme, secret)).update(message).digest(scheme.encoding);
    // Every candidate is compared: stopping at the first match would leak its position.
    let match = false;
    for (const candidate of candidates) if (safeEqual(expected, candidate)) match = true;
    if (!match) return { ok: false, reason: 'bad_signature' };
  } else {
    const key = publicKeyOf(scheme, secret);
    const strict = scheme.signature.encoding === 'hex' ? /^[0-9a-fA-F]{128}$/ : /^[A-Za-z0-9+/]{86}==$/;
    if (!key || !strict.test(value)) return { ok: false, reason: 'bad_signature' };
    let valid = false;
    try { valid = verifySignatureBytes(null, message, key, Buffer.from(value, scheme.signature.encoding)); } catch { valid = false; }
    if (!valid) return { ok: false, reason: 'bad_signature' };
  }

  let verifiedAt: number | null = null;
  if (scheme.timestamp) {
    verifiedAt = timestampMs(scheme, raw, body);
    if (verifiedAt === null || Math.abs(nowMs - verifiedAt) > scheme.timestamp.windowS * 1000) {
      return { ok: false, reason: 'stale_timestamp' };
    }
  }

  const { id, idSource } = deliveryId(scheme, parts, headers, body);
  // The message digest is what the secret authenticated: a replay with any
  // unsigned header changed still lands on it.
  const keys = [`msg:${sha256(message).toString('hex')}`, `id:${id}`];
  return { ok: true, id, idSource, timestampMs: verifiedAt, replayKeys: keys };
}

/**
 * The reply the host gives by itself to a verified handshake (Slack
 * `url_verification`, Discord `PING`), or `null` when the call is an event.
 */
export function handshakeReply(scheme: WebhookScheme, body: Buffer): Record<string, unknown> | null {
  if (scheme.kind === 'token' || !scheme.handshakes?.length) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const json = parsed as Record<string, unknown>;
  for (const handshake of scheme.handshakes) {
    if (json[handshake.when.field] !== handshake.when.equals) continue;
    if ('json' in handshake.reply) return { ...handshake.reply.json };
    const echoed = json[handshake.reply.echo];
    if (typeof echoed !== 'string' || echoed.length > 512) return null;
    return { [handshake.reply.echo]: echoed };
  }
  return null;
}

/**
 * The verify token of a subscription GET. Derived, not random: it is typed
 * once into the service's dashboard, and it carries no power beyond answering
 * that GET — events still need the secret's signature. It travels in a query
 * string because that is the sender's protocol; it is never the secret.
 */
export function verifyTokenOf(secret: string): string {
  return createHmac('sha256', secret).update('timon-webhook-verify-token').digest('hex').slice(0, 32);
}

/** A challenge is echoed as text: kept to characters that cannot form markup. */
const CHALLENGE_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * The challenge to echo for a subscription GET, or `null` — wrong mode, wrong
 * token, no subscription in the scheme. `secrets` are tried in order (the
 * current one, then the previous one during a rotation), all of them compared.
 */
export function subscribeChallenge(scheme: WebhookScheme, secrets: readonly string[], query: URLSearchParams): string | null {
  if (scheme.kind !== 'hmac' || !scheme.subscribe) return null;
  const { modeParam, mode, tokenParam, challengeParam } = scheme.subscribe;
  const given = query.get(tokenParam);
  const challenge = query.get(challengeParam);
  if (query.get(modeParam) !== mode || given === null || challenge === null || given.length > 128) return null;
  let match = false;
  for (const secret of secrets) if (safeEqual(verifyTokenOf(secret), given)) match = true;
  return match && CHALLENGE_RE.test(challenge) ? challenge : null;
}
