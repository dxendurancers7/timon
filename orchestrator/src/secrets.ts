/**
 * Loading of `~/.timon/secrets.env` — the daemon's secrets file.
 *
 * Until now, the credentials (`TELEGRAM_BOT_TOKEN`,
 * `TIMON_REMOTE_MASTER`, `TIMON_VAPID_PRIVATE_KEY`) reached the daemon's environment
 * through the `EnvironmentFile=` of the systemd unit, or through the compose `env_file:`
 * on the container side. Two distinct mechanisms, two files, and above all:
 * a dependency on the init system, which P3 precisely seeks to make optional.
 * On a machine without systemd (macOS, Windows, a `node dist/index.js` run by
 * hand), the secrets were simply not there.
 *
 * So we read the file ourselves, at the very start of the boot. Three rules:
 *
 * 1. **The environment already set wins.** A variable present in
 *    `process.env` is never overwritten: systemd, the shell or a one-shot run
 *    must be able to force a value without editing the file. It is the same
 *    priority as everywhere else in TIMON (see `settings.ts`).
 * 2. **Missing file = no-op.** An installation without secrets starts: the
 *    modules concerned disable themselves (push, telegram…).
 * 3. **No value is logged.** The log only quotes the NAMES of the keys
 *    loaded. `secrets.env` is in the `secrets` zone (`paths.ts`), hence out of
 *    any export; the log must not reopen the door the zoning closes.
 *
 * The NON-secret keys (`TIMON_ALLOW_HTTP`, `TIMON_VAPID_PUBLIC_KEY`)
 * have no business here: they live in the
 * `settings.ts` registry, hence in `timon.config.json > settings` or the `settings` table,
 * where they are visible and editable from the UI.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TIMON_HOME, portablePath } from './paths.js';

export const SECRETS_FILE = join(TIMON_HOME, 'secrets.env');

/** POSIX environment variable name. Everything else is silently ignored:
 *  a malformed line must not prevent the following ones from being read. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `KEY=VALUE` parser. Deliberately minimal — no dependency, no
 * `${…}` interpolation, no multi-line value: `secrets.env` is a
 * token file, not a language.
 *
 * Recognises: empty lines, `#` comments, `export ` prefix, values
 * wrapped in single or double quotes. A `#` in the middle of a value is
 * kept as is: a token has every right to contain one, and
 * cutting it silently would produce an invalid key impossible to diagnose.
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.replace(/^﻿/, '').split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Loads the file into `process.env` and returns the NAMES of the keys actually
 * set (so neither those already present in the environment, nor the ignored
 * lines). Never the values: this return serves the log.
 */
export function loadSecrets(file: string = SECRETS_FILE): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  // A world-readable `secrets.env` is a silent incident:
  // say it once, without blocking (the file may be managed by a third-party
  // tool, and refusing to start would be worse than the risk).
  try {
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) {
      console.warn(`[secrets] ${portablePath(file)} is readable by other users — chmod 600 recommended`);
    }
  } catch { /* stat impossible: no reason to refuse the boot */ }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(raw))) {
    // The environment already set (systemd, shell, one-shot run) has priority.
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** Loads and logs — the key names only, never the values. */
export function loadSecretsAtBoot(file: string = SECRETS_FILE): string[] {
  const applied = loadSecrets(file);
  if (applied.length) {
    console.log(`[secrets] ${applied.length} variable(s) loaded from ${portablePath(file)}: ${applied.join(', ')}`);
  }
  return applied;
}

/** Credentials that are dangerous by name whatever the secrets file says: the
 *  systemd unit or a compose `env_file:` may set them directly. */
const KNOWN_SECRET_KEYS: readonly string[] = Object.freeze([
  'TIMON_REMOTE_MASTER', 'TELEGRAM_BOT_TOKEN', 'TIMON_VAPID_PRIVATE_KEY', 'STRIPE_WEBHOOK_SECRET',
]);
/** A name that reads as a credential even when it is not in the file. */
const SECRET_NAME_RE = /(?:^|_)(?:SECRET|PRIVATE_KEY|BOT_TOKEN|API_KEY|PASSWORD|PASSWD|CREDENTIALS?)$/i;

/** NAMES of the keys declared in the secrets file. Never the values. */
export function secretEnvNames(file: string = SECRETS_FILE): string[] {
  try { return Object.keys(parseEnvFile(readFileSync(file, 'utf8'))); } catch { return []; }
}

/**
 * A copy of `env` with every secret removed. The legacy `secrets.inheritEnv`
 * mode inherits the ordinary environment, never the vault: it withholds the
 * known credential names, everything declared in the secrets file, and any
 * name that reads as a credential. Returns the names withheld (never values)
 * so the caller can log them.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv, file: string = SECRETS_FILE): { env: NodeJS.ProcessEnv; withheld: string[] } {
  const declared = new Set(secretEnvNames(file));
  const out: NodeJS.ProcessEnv = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (KNOWN_SECRET_KEYS.includes(key) || declared.has(key) || SECRET_NAME_RE.test(key)) { withheld.push(key); continue; }
    out[key] = value;
  }
  return { env: out, withheld };
}

/**
 * The VALUES of the credentials present in the environment or the secrets file.
 * Only for egress redaction, never logged. Values shorter than 8 characters are
 * skipped so a common word cannot redact half of every payload.
 */
export function secretEnvValues(file: string = SECRETS_FILE): string[] {
  const declared = new Set(secretEnvNames(file));
  const values: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (KNOWN_SECRET_KEYS.includes(key) || declared.has(key) || SECRET_NAME_RE.test(key)) values.push(value);
  }
  return values;
}
