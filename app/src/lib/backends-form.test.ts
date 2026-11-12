import assert from 'node:assert/strict';
import test from 'node:test';
import { blankForm, BACKEND_PRESETS, createPayload, destinationHost, effectiveReasoning, formErrorKey, formOf, mergeDiscovered, modelsErrorKey, outcomeMessage, parseLevels, presetForm, testPayload, thinkingChoiceOf, updatePayload, withThinkingChoice } from '@/plugins-client/backends/form';
import type { CustomBackend } from '@/plugins-client/backends/form';

const filled = { ...blankForm(), name: ' DeepSeek ', baseUrl: ' https://api.deepseek.com/anthropic ', key: ' sk-x ' };

test('the form refuses a missing name and an address that is not http(s)', () => {
  assert.equal(formErrorKey(blankForm()), 'backendsSettings.errors.nameRequired');
  assert.equal(formErrorKey({ ...filled, baseUrl: 'ftp://x' }), 'backendsSettings.errors.urlInvalid');
  assert.equal(formErrorKey({ ...filled, baseUrl: 'api.deepseek.com' }), 'backendsSettings.errors.urlInvalid');
  assert.equal(formErrorKey(filled), null);
});

test('what is sent is trimmed, and an empty key is not sent at all', () => {
  assert.deepEqual(createPayload(filled), { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', protocol: 'anthropic', key: 'sk-x' });
  assert.equal('key' in createPayload({ ...filled, key: '  ' }), false);
  assert.equal('key' in testPayload({ ...filled, key: '' }), false);
  assert.deepEqual(createPayload({ ...filled, key: '', models: [{ slug: ' m-1 ', label: '' }] }).models, [{ slug: 'm-1', label: 'm-1' }]);
});

test('the notice names the host the prompts go to', () => {
  assert.equal(destinationHost(filled.baseUrl), 'api.deepseek.com');
  assert.equal(destinationHost('nope'), null);
});

test('each outcome of a test reads as its own message', () => {
  assert.equal(outcomeMessage({ outcome: 'ok', status: 200, models: [] }).key, 'backendsSettings.test.ok');
  assert.deepEqual(outcomeMessage({ outcome: 'ok', status: 200, models: ['a', 'b'] }).vars, { count: 2 });
  assert.equal(outcomeMessage({ outcome: 'key-refused', status: 401 }).tone, 'error');
  assert.equal(outcomeMessage({ outcome: 'unreachable' }).key, 'backendsSettings.test.unreachable');
  // A provider that serves completions but lists no models answers 404 — the
  // user has to name them, which is a different sentence from "something odd
  // happened".
  assert.equal(outcomeMessage({ outcome: 'unexpected-status', status: 404 }).key, 'backendsSettings.test.noListing');
  assert.equal(outcomeMessage({ outcome: 'unexpected-status', status: 500 }).key, 'backendsSettings.test.unexpected');
});

test('a model list is refused when it cannot be told apart, or sent to the CLI', () => {
  assert.equal(modelsErrorKey([{ slug: 'a', label: 'A' }, { slug: 'b', label: 'B' }]), null);
  assert.equal(modelsErrorKey([{ slug: ' ', label: 'A' }]), 'backendsSettings.errors.modelSlugRequired');
  assert.equal(modelsErrorKey([{ slug: 'a', label: 'A' }, { slug: 'a', label: 'Other' }]), 'backendsSettings.errors.modelDuplicate');
});

test('a test proposes the models it found and overwrites none', () => {
  const named = [{ slug: 'deepseek-chat', label: 'Chat', icon: '🐋' }];
  assert.deepEqual(mergeDiscovered(named, ['deepseek-chat', 'deepseek-reasoner']), [
    { slug: 'deepseek-chat', label: 'Chat', icon: '🐋' },
    { slug: 'deepseek-reasoner', label: 'deepseek-reasoner' },
  ]);
});

test('reopening a backend carries everything but the key, which is never sent back', () => {
  const saved: CustomBackend = {
    id: 'deepseek', file: 'deepseek.json', label: 'DeepSeek', dialect: 'claude',
    protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic',
    models: [{ slug: 'deepseek-chat', label: 'Chat' }], defaultModel: 'deepseek-chat',
    icon: null, brand: 'deepseek', hasVaultKey: true, active: true, reason: null, warnings: [],
  };
  const form = formOf(saved);
  assert.deepEqual([form.id, form.key, form.brand, form.defaultModel], ['deepseek', '', 'deepseek', 'deepseek-chat']);

  // An untouched key field must not reach the daemon: there, absent means
  // "keep the stored one" and an empty string would be a refusal.
  assert.equal('key' in updatePayload(form), false);
  assert.equal(updatePayload({ ...form, key: ' sk-new ' }).key, 'sk-new');
  // Cleared pictures travel as null — absent would mean "leave as is".
  assert.deepEqual(updatePayload({ ...form, brand: null }).brand, null);
});

test('managed backends send presentation only, keep exact slugs and omit client timestamps', () => {
  const form = { ...blankForm(), id: 'claude', origin: 'builtin' as const, name: 'My provider',
    baseUrl: 'https://should-not-be-sent.invalid', key: 'secret',
    models: [{ slug: 'claude-fable-5-1', label: 'Pinned', addedAt: 1, hidden: false }],
    defaultModel: 'claude-fable-5-1' };
  assert.equal(formErrorKey({ ...form, baseUrl: '' }), null);
  const payload = updatePayload(form);
  for (const field of ['name', 'baseUrl', 'key', 'protocol', 'cmd']) assert.equal(field in payload, false);
  // `contextWindow: null` = no hand-typed window, the detected one applies (#175).
  assert.deepEqual(payload.models, [{ slug: 'claude-fable-5-1', label: 'Pinned', icon: null, brand: null, hidden: false, contextWindow: null }]);
  assert.equal(payload.defaultModel, 'claude-fable-5-1');
  assert.equal(payload.label, 'My provider');
});

test('hand-written profiles can edit models without inventing an address or protocol', () => {
  const saved: CustomBackend = { id: 'hand', file: 'hand.json', origin: 'file', label: 'Hand',
    dialect: 'plugin-protocol', protocol: null, baseUrl: null, models: [], defaultModel: null,
    icon: null, brand: null, hasVaultKey: false, active: true, reason: null, warnings: [] };
  const form = formOf(saved);
  assert.equal(formErrorKey(form), null);
  assert.equal(form.connectionEditable, false);
  const payload = updatePayload(form);
  assert.equal(payload.name, 'Hand');
  for (const field of ['baseUrl', 'key', 'protocol']) assert.equal(field in payload, false);
});

test('a built-in backend reports the models deleted or renamed since the form opened', () => {
  const saved: CustomBackend = { id: 'claude', file: null, origin: 'builtin', label: 'Claude',
    dialect: null, protocol: null, baseUrl: null,
    models: [{ slug: 'opus', label: 'Opus' }, { slug: 'fable', label: 'Fable' }, { slug: 'haiku', label: 'Haiku' }],
    defaultModel: 'opus', icon: null, brand: null, hasVaultKey: false, active: true, reason: null, warnings: [] };
  const form = formOf(saved);
  assert.equal('removedModels' in updatePayload(form), false);
  const edited = { ...form, models: [{ slug: 'claude-opus-5-5', label: 'Opus' }], defaultModel: 'claude-opus-5-5' };
  assert.deepEqual(updatePayload(edited).removedModels, ['opus', 'fable', 'haiku']);
});

test('a thinking setting picked by hand is sent alone, the other kind cleared, and only for a provider the user added', () => {
  const qwen = { slug: 'qwen3.8-max', label: 'Qwen', detectedReasoning: { source: 'catalog' as const, thinks: true, controls: [{ type: 'budget' as const, min: 0, max: 262144 }], catalogEntry: 'alibaba/qwen3.8-max' } };
  assert.equal(thinkingChoiceOf(qwen), 'auto');
  const budget = withThinkingChoice(qwen, 'budget', { max: 16000 });
  assert.deepEqual(budget.reasoningControl, { type: 'budget', max: 16000 });
  const levels = withThinkingChoice(budget, 'levels', { levels: ['low', 'high'] });
  assert.equal(levels.reasoningControl, undefined, 'one declaration at a time');
  assert.equal(thinkingChoiceOf(levels), 'levels');
  assert.equal(thinkingChoiceOf(withThinkingChoice(levels, 'auto')), 'auto');
  assert.deepEqual(parseLevels(' low, medium high,,low '), ['low', 'medium', 'high']);

  const form = { ...blankForm(), id: 'bai', origin: 'file' as const, connectionEditable: true, name: 'B.AI', baseUrl: 'https://api.b.ai',
    models: [budget, { slug: 'qwen3.8-27b', label: '27b' }], defaultModel: 'qwen3.8-max' };
  const [first, second] = updatePayload(form).models as Record<string, unknown>[];
  assert.deepEqual(first!.reasoningControl, { type: 'budget', max: 16000 });
  assert.equal(first!.supportedReasoningLevels, null);
  assert.equal(second!.reasoningControl, null, 'an edit clears what is no longer chosen');
  assert.equal('reasoning' in first! || 'detectedReasoning' in first!, false, 'read-only views are never sent');

  const created = createPayload({ ...form, id: null, origin: undefined, models: [levels] }).models as Record<string, unknown>[];
  assert.deepEqual(created[0]!.supportedReasoningLevels, ['low', 'high']);
  assert.equal('reasoningControl' in created[0]!, false);

  const builtin = updatePayload({ ...form, origin: 'builtin' }).models as Record<string, unknown>[];
  assert.equal('reasoningControl' in builtin[0]!, false, 'a built-in provider declares its own');
});

test('the levels a Test reported travel with the models and count as detected until the first save', () => {
  const merged = mergeDiscovered([{ slug: 'claude-opus-5-5', label: 'Opus' }], ['claude-opus-5-5', 'qwen3.8-max'], { 'claude-opus-5-5': ['low', 'max'] });
  assert.deepEqual(merged.map((model) => model.reportedReasoningLevels), [['low', 'max'], undefined]);
  assert.deepEqual(effectiveReasoning(merged[0]!), { source: 'agent', thinks: true, controls: [{ type: 'levels', values: ['low', 'max'] }] });
  assert.equal(effectiveReasoning(merged[1]!), undefined);
  assert.deepEqual(effectiveReasoning(withThinkingChoice(merged[0]!, 'none')), { source: 'declared', thinks: false, controls: [] });
  const sent = createPayload({ ...blankForm(), name: 'X', baseUrl: 'https://x.example', models: merged }).models as Record<string, unknown>[];
  assert.deepEqual(sent[0]!.reportedReasoningLevels, ['low', 'max']);
});

test('the oMLX and DeepSeek presets prefill the protocol and endpoint', () => {
  const omlx = presetForm(BACKEND_PRESETS.find((preset) => preset.id === 'omlx')!);
  assert.equal(omlx.id, null);
  assert.equal(omlx.protocol, 'openai-responses');
  assert.equal(omlx.baseUrl, 'http://127.0.0.1:8000/v1');
  assert.equal(formErrorKey(omlx), null);

  const deepseek = presetForm(BACKEND_PRESETS.find((preset) => preset.id === 'deepseek')!);
  assert.equal(deepseek.protocol, 'anthropic');
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.deepEqual(deepseek.models.map((model) => model.slug), ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(deepseek.defaultModel, 'deepseek-chat');
  assert.equal(formErrorKey(deepseek), null);
});
