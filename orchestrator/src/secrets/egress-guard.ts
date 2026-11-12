/**
 * Last line of defence against credential exfiltration.
 *
 * The address policy (`plugins/net-guard.ts`) decides WHERE the daemon may
 * connect. This module decides WHAT may leave: every known credential value —
 * the vault's, the secrets file's, and any environment key that reads as a
 * secret — is replaced by a marker before a payload is queued for delivery.
 * Redaction happens at enqueue time, before a webhook signature is computed, so
 * the signature stays valid for the body that is actually sent.
 *
 * It is a safety net, not the primary control: plugins never receive the vault
 * (`secretsEnvFor` grants), and outbound destinations are operator-approved.
 */
import { secretEnvValues } from '../secrets.js';
import { listSecrets, readSecretValue } from './store.js';

export const REDACTED = '[REDACTED]';

/**
 * Values from the encrypted vault. A credential created through the vault is a
 * database row, not a `process.env` entry, so the env-only snapshot would miss
 * it. A locked vault or an unreadable row is skipped, never an error.
 */
function vaultSecretValues(): string[] {
  try {
    const out: string[] = [];
    for (const secret of listSecrets()) {
      try {
        const value = readSecretValue(secret.id);
        if (value && value.length >= 8) out.push(value);
      } catch { /* locked, missing key, or removed: skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Every credential value to redact: the environment's and the vault's. */
function egressSecrets(): string[] {
  return [...secretEnvValues(), ...vaultSecretValues()];
}

/** One pass over a string with an already-collected snapshot of the secrets. */
function replaceAll(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Replace every known credential value in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  return text ? replaceAll(text, egressSecrets()) : text;
}

/**
 * Redact the strings of a value, preserving JSON serialization semantics:
 * a `Date` serializes through `toJSON` (its ISO string), not as `{}`; a
 * `Buffer` keeps its `{ type, data }` form. The secret snapshot is collected
 * ONCE per payload — not once per string, which would re-read the vault file
 * for every element of a large array.
 */
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return replaceAll(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (value !== null && typeof value === 'object') {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === 'function') {
      const next = withToJson.toJSON();
      return next === value ? value : redactValue(next, secrets);
    }
    // `Object.fromEntries` defines own data properties, so an own `__proto__`
    // key is preserved instead of invoking the prototype setter.
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]));
  }
  return value;
}

/** Recursively redact the strings of a JSON-serialisable value. */
export function redactSecretsDeep<T>(value: T): T {
  return redactValue(value, egressSecrets()) as T;
}

/**
 * Whether `text` still carries a known credential. Outbound code may use this
 * to refuse rather than send: a payload that still holds a secret after
 * redaction names something the vault does not know about, and silence is safer
 * than a leak.
 */
export function containsSecret(text: string): boolean {
  return egressSecrets().some((secret) => secret.length > 0 && text.includes(secret));
}
