import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `secrets.ts` pulls in `paths.ts`, which refuses to load without a Timon home.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-egress-test-'));
// A known credential name (`secrets.ts` lists it) with a value long enough to redact.
process.env.TIMON_REMOTE_MASTER = 'master-'.padEnd(40, 'x');

const { containsSecret, redactSecrets, redactSecretsDeep } = await import('./egress-guard.js');

test('a known credential value is removed from outbound text', () => {
  const secret = process.env.TIMON_REMOTE_MASTER!;
  assert.equal(redactSecrets(`token=${secret}`), 'token=[REDACTED]');
  assert.equal(redactSecrets('nothing to hide'), 'nothing to hide');
  assert.equal(containsSecret(`token=${secret}`), true);
  assert.equal(containsSecret('nothing to hide'), false);
});

test('deep redaction reaches nested payloads', () => {
  const secret = process.env.TIMON_REMOTE_MASTER!;
  assert.deepEqual(redactSecretsDeep({ a: [secret, 'ok'], b: { c: secret } }), {
    a: ['[REDACTED]', 'ok'],
    b: { c: '[REDACTED]' },
  });
});

test('deep redaction leaves numbers alone and still finds a quoted secret', () => {
  // Redacting serialized JSON would rewrite a number equal to a secret; redacting
  // the parsed value must not.
  const numeric = JSON.parse(JSON.stringify(redactSecretsDeep({ id: 12345678 })));
  assert.deepEqual(numeric, { id: 12345678 });
  // A secret with JSON-special characters is a string value, so it is found before serialisation.
  process.env.TIMON_VAPID_PRIVATE_KEY = 'a"b\\c-d_e';
  const out = JSON.parse(JSON.stringify(redactSecretsDeep({ note: `x a"b\\c-d_e y` })));
  assert.equal(out.note, 'x [REDACTED] y');
});

test('deep redaction preserves Date/Buffer JSON semantics', () => {
  const at = new Date('2026-01-02T03:04:05.000Z');
  const buf = Buffer.from('hi');
  const redacted = redactSecretsDeep({ at, buf });
  assert.equal(JSON.stringify(redacted), JSON.stringify({ at, buf }));
});

test('deep redaction preserves an own __proto__ key', () => {
  const parsed = JSON.parse('{"__proto__":{"x":1},"a":"b"}') as Record<string, unknown>;
  assert.equal(JSON.stringify(redactSecretsDeep(parsed)), JSON.stringify(parsed));
});
