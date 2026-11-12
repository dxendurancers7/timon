/** Drag and drop in the Files widget moves inside the agent's folder, never out of it and never over something (TODO #243). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-files-move-test-'));
const { AGENTS_DIR } = await import('./paths.js');
const { moveAgentPath, renameAgentPath } = await import('./files.js');

const work = mkdtempSync(join(tmpdir(), 'timon-files-move-cwd-'));
const outside = mkdtempSync(join(tmpdir(), 'timon-files-move-out-'));
mkdirSync(join(AGENTS_DIR, 'a'), { recursive: true });
writeFileSync(join(AGENTS_DIR, 'a', 'config.json'), JSON.stringify({ cwd: work }));
mkdirSync(join(work, 'src', 'deep'), { recursive: true });
mkdirSync(join(work, 'docs'));
writeFileSync(join(work, 'a.txt'), 'x');
writeFileSync(join(work, 'docs', 'a.txt'), 'y');
writeFileSync(join(work, 'b.txt'), 'z');
symlinkSync(outside, join(work, 'link'));

test('moves a file into a folder', () => {
  const r = moveAgentPath('a', 'b.txt', 'src');
  assert.deepEqual(r, { kind: 'moved', from: 'b.txt', path: 'src/b.txt' });
  assert.ok(existsSync(join(work, 'src', 'b.txt')) && !existsSync(join(work, 'b.txt')));
});

test('moves a file back to the root', () => {
  assert.equal(moveAgentPath('a', 'src/b.txt', '').path, 'b.txt');
});

test('refuses to overwrite an entry of the same name', () => {
  assert.throws(() => moveAgentPath('a', 'a.txt', 'docs'), /already exists/);
  assert.ok(existsSync(join(work, 'a.txt')));
});

test('refuses to move a folder into itself or its own child', () => {
  assert.throws(() => moveAgentPath('a', 'src', 'src'), /into itself/);
  assert.throws(() => moveAgentPath('a', 'src', 'src/deep'), /into itself/);
});

test('refuses the root, a missing source and a destination that is not a folder', () => {
  assert.throws(() => moveAgentPath('a', '', 'docs'), /path required/);
  assert.throws(() => moveAgentPath('a', 'nope.txt', 'docs'), /not found/);
  assert.throws(() => moveAgentPath('a', 'b.txt', 'a.txt'), /not a folder/);
});

test('refuses to leave the agent folder, by .. or through a symlink', () => {
  assert.throws(() => moveAgentPath('a', 'b.txt', '../'), /escapes/);
  assert.throws(() => moveAgentPath('a', '../x', 'docs'), /escapes/);
  assert.throws(() => moveAgentPath('a', 'b.txt', 'link'), /escapes/);
  assert.ok(!existsSync(join(outside, 'b.txt')));
});

test('refuses to touch .git and node_modules', () => {
  mkdirSync(join(work, '.git'));
  assert.throws(() => moveAgentPath('a', '.git/HEAD', 'docs'), /refused|not found/);
  writeFileSync(join(work, 'docs', 'c.txt'), '');
  mkdirSync(join(work, 'node_modules'));
  assert.throws(() => moveAgentPath('a', 'docs/c.txt', 'node_modules'), /refused/);
});

test('renames in place and never overwrites', () => {
  writeFileSync(join(work, 'docs', 'old.txt'), '');
  assert.deepEqual(renameAgentPath('a', 'docs/old.txt', 'new.txt'), { kind: 'renamed', from: 'docs/old.txt', path: 'docs/new.txt' });
  assert.ok(existsSync(join(work, 'docs', 'new.txt')));
  assert.throws(() => renameAgentPath('a', 'docs/new.txt', 'a.txt'), /already exists/);
});

test('a change of case only renames; another entry with that spelling is never overwritten (TIM-0132)', () => {
  const docs = join(work, 'docs');
  writeFileSync(join(docs, 'case.txt'), 'mine');
  // A case-SENSITIVE volume holds both spellings as two files; a case-insensitive
  // one (macOS default, this test's tmpdir) cannot even represent the scenario.
  writeFileSync(join(docs, 'CASE.txt'), 'other');
  const caseSensitive = readdirSync(docs).filter((name) => name.toLowerCase() === 'case.txt').length === 2;
  if (caseSensitive) {
    assert.throws(() => renameAgentPath('a', 'docs/case.txt', 'CASE.txt'), /already exists/);
    assert.equal(readFileSync(join(docs, 'CASE.txt'), 'utf8'), 'other', 'the other file is intact');
  }
  // A hard link is the same inode under another name: still a different name, refused.
  linkSync(join(docs, 'case.txt'), join(docs, 'Linked.txt'));
  assert.throws(() => renameAgentPath('a', 'docs/case.txt', 'Linked.txt'), /already exists/);
  // Alone in its folder, the new spelling is free and the rename happens.
  mkdirSync(join(work, 'solo'));
  writeFileSync(join(work, 'solo', 'notes.txt'), 'n');
  assert.equal(renameAgentPath('a', 'solo/notes.txt', 'Notes.txt').path, 'solo/Notes.txt');
  assert.ok(readdirSync(join(work, 'solo')).includes('Notes.txt'));
});

test('a new name is a bare name: no separator, no dots, no empty', () => {
  for (const bad of ['', '  ', '.', '..', '../x', 'a/b', 'a\\b']) {
    assert.throws(() => renameAgentPath('a', 'docs/new.txt', bad), /invalid name/);
  }
  assert.throws(() => renameAgentPath('a', '../x', 'y'), /escapes/);
  assert.throws(() => renameAgentPath('a', 'docs/new.txt', 'new.txt'), /same name/);
});
