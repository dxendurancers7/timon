/**
 * Tests de la dérivation d'URL locale depuis les labels Traefik (docker.ts).
 *
 * `node --test --import tsx src/docker.test.ts` (ou `npm test`). C'est la seule
 * partie du module qui peut se tromper en silence : une mauvaise URL donne un
 * lien qui a l'air valide et n'ouvre rien.
 */
// Isole TIMON_HOME AVANT tout module qui touche à l'état TIMON (cf. test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, missingNetwork, traefikUrl } from './docker.js';
import { getHost, type ExecResult } from './host/index.js';
import { writeMeta } from './projects.js';

test('pas de label traefik → pas d’URL', () => {
  assert.equal(traefikUrl({}), null);
  assert.equal(traefikUrl({ 'com.docker.compose.service': 'db' }), null);
});

test('règle Host simple → URL http', () => {
  assert.equal(
    traefikUrl({ 'traefik.http.routers.app.rule': 'Host(`contoso.localhost`)' }),
    'http://contoso.localhost',
  );
});

test('routeur en tls → https gagne sur le jumeau http du même hôte', () => {
  const url = traefikUrl({
    'traefik.http.routers.app.rule': 'Host(`timon.localhost`)',
    'traefik.http.routers.app-secure.rule': 'Host(`timon.localhost`)',
    'traefik.http.routers.app-secure.tls': 'true',
  });
  assert.equal(url, 'https://timon.localhost');
});

test('entrypoint websecure vaut tls', () => {
  assert.equal(
    traefikUrl({
      'traefik.http.routers.app.rule': 'Host(`globex.localhost`)',
      'traefik.http.routers.app.entrypoints': 'web,websecure',
    }),
    'https://globex.localhost',
  );
});

test('à égalité, l’hôte le moins profond gagne', () => {
  // Cas réel TIMON : `channels.timon.localhost` ne doit pas éclipser l'app.
  const url = traefikUrl({
    'traefik.http.routers.channels.rule': 'Host(`channels.timon.localhost`)',
    'traefik.http.routers.app.rule': 'Host(`timon.localhost`)',
  });
  assert.equal(url, 'http://timon.localhost');
});

test('un hôte .localhost prime sur un hôte public ou tailscale', () => {
  const url = traefikUrl({
    'traefik.http.routers.ts.rule': 'Host(`my-laptop.tail0000.ts.net`)',
    'traefik.http.routers.app.rule': 'Host(`app.localhost`)',
  });
  assert.equal(url, 'http://app.localhost');
});

test('règle composite : les hôtes multiples et les clauses annexes sont gérés', () => {
  const url = traefikUrl({
    'traefik.http.routers.app.rule': 'Host(`a.localhost`, `b.localhost`) && PathPrefix(`/api`)',
  });
  // Deux hôtes de même score : n'importe lequel est acceptable, l'important
  // est qu'aucune clause parasite ne se retrouve dans l'URL.
  assert.ok(url === 'http://a.localhost' || url === 'http://b.localhost');
});

test('règle sans Host (PathPrefix seul) → pas d’URL inventée', () => {
  assert.equal(traefikUrl({ 'traefik.http.routers.app.rule': 'PathPrefix(`/api`)' }), null);
});

/* ── TIM-0104 : start sur un réseau supprimé ─────────────────────────────── */

test('missingNetwork lit le réseau quelle que soit la formulation de docker', () => {
  assert.equal(missingNetwork('Error response from daemon: network traefik_network not found'), 'traefik_network');
  assert.equal(
    missingNetwork('Error response from daemon: failed to set up container networking: network "traefik_network" not found'),
    'traefik_network',
  );
  assert.equal(missingNetwork('Error response from daemon: No such container: abc'), null);
});

type Fake = { calls: string[][]; restore: () => void };

/** Docker simulé : deux conteneurs compose arrêtés, créés sur un réseau qui
 *  n'existe plus. `start` échoue tant que `up -d` ne les a pas recréés ;
 *  `upFails` simule un compose qui référence lui aussi un réseau absent. */
function fakeDocker(cwd: string, opts: { composeFile: boolean; upFails?: boolean }): Fake {
  const composeFile = join(cwd, 'compose.yaml');
  if (opts.composeFile) writeFileSync(composeFile, 'services: {}\n');
  let running = false;
  const calls: string[][] = [];
  const containers = ['app', 'db'].map((service, i) => ({
    id: `${String(i + 1).repeat(12)}aaaa`,
    service,
  }));
  const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
  const ko = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
  const cli = (args: string[]): ExecResult => {
    calls.push(args);
    if (args[0] === 'ps') return ok(containers.map((c) => c.id).join('\n'));
    if (args[0] === 'inspect') {
      return ok(containers.map((c) => JSON.stringify({
        id: c.id,
        name: `/proj-${c.service}-1`,
        state: running ? 'running' : 'exited',
        health: null,
        started: '0001-01-01T00:00:00Z',
        labels: {
          'com.docker.compose.project': 'proj',
          'com.docker.compose.service': c.service,
          'com.docker.compose.project.working_dir': cwd,
          'com.docker.compose.project.config_files': composeFile,
        },
        ports: {},
      })).join('\n'));
    }
    if (args.includes('up')) {
      if (opts.upFails) return ko('network proxy_net declared as external, but could not be found');
      running = true;
      return ok();
    }
    if (args.includes('start') || args.includes('restart')) {
      return ko('Error response from daemon: network traefik_network not found');
    }
    return ko(`unexpected docker ${args.join(' ')}`);
  };
  const host = getHost();
  const original = host.containers;
  host.containers = { cli };
  return { calls, restore: () => { host.containers = original; } };
}

let seq = 0;
function project(): { slug: string; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'tim0104-'));
  const slug = `tim0104-${++seq}`;
  writeMeta(slug, { cwd });
  return { slug, cwd };
}

/** Le scan docker est mis en cache 1,5 s : on l'attend pour que chaque test
 *  relise le docker simulé qu'il vient de poser. */
const settle = () => new Promise((r) => setTimeout(r, 1600));

test('start sur un réseau supprimé → la stack est recréée par compose up -d', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: true });
  try {
    const status = act(slug, 'start');
    assert.equal(status.state, 'running');
    const up = fake.calls.find((a) => a.includes('up'));
    assert.ok(up, 'compose up -d attendu après l’échec du start');
    assert.deepEqual(up.slice(-2), ['up', '-d']);
    assert.ok(!up.includes('--build'), 'pas de rebuild d’image pour un simple changement de réseau');
  } finally { fake.restore(); }
});

test('start d’un seul conteneur → seul son service est recréé', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: true });
  try {
    act(slug, 'start', 'proj-db-1');
    const up = fake.calls.find((a) => a.includes('up'));
    assert.ok(up);
    // `--` terminates the options: a service label cannot be read as a flag.
    assert.deepEqual(up.slice(-4), ['up', '-d', '--', 'db']);
  } finally { fake.restore(); }
});

test('compose up -d échoue aussi → message qui nomme le réseau et propose Rebuild', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: true, upFails: true });
  try {
    assert.throws(() => act(slug, 'restart'), (err: Error) =>
      err.message.includes('"traefik_network" no longer exists')
      && err.message.includes('proxy_net')
      && err.message.includes('Rebuild'));
  } finally { fake.restore(); }
});

test('fichiers compose disparus → pas de repli, message qui donne la commande', async () => {
  await settle();
  const { slug, cwd } = project();
  const fake = fakeDocker(cwd, { composeFile: false });
  try {
    assert.throws(() => act(slug, 'start'), (err: Error) =>
      err.message.includes('"traefik_network" no longer exists')
      && err.message.includes('docker compose up -d'));
    assert.ok(!fake.calls.some((a) => a.includes('up')));
  } finally { fake.restore(); }
});
