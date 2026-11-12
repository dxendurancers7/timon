/**
 * Pure half of Settings → AI models → Providers: what the form sends and how an answer of
 * the daemon reads. Kept out of the component so it is tested without a DOM.
 */

import type { DeclaredReasoningControl, ModelReasoning } from '@/lib/backends';
import { formatContextWindow, parseContextWindow } from '@/lib/context-window';

export type BackendProtocol = 'anthropic' | 'openai-responses';

/** A model as the form edits it: the slug is what the CLI is given, the rest
 *  is how it reads in a menu. */
export type ModelDraft = {
  slug: string;
  hidden?: boolean;
  addedAt?: number;
  presetLabel?: string;
  label: string;
  /** Emoji, or image served by our own uploads route. */
  icon?: string;
  /** Key of a logo the product ships (`brand-icons.tsx`). */
  brand?: string;
  /** Thinking levels declared by hand (user-added providers only). */
  supportedReasoningLevels?: string[];
  /** A budget, a switch or "does not think", declared by hand. */
  reasoningControl?: DeclaredReasoningControl;
  /** Levels the endpoint's own listing reported on a Test. */
  reportedReasoningLevels?: string[];
  /** Read-only, from the daemon: what applies, and what was detected without
   *  the user's declaration. */
  reasoning?: ModelReasoning;
  detectedReasoning?: ModelReasoning;
  /** From the daemon: the window that applies, and whether the user typed it. */
  contextWindow?: number;
  contextWindowDeclared?: boolean;
  /** From the daemon: what the product knows without the user's figure. */
  detectedContextWindow?: number;
  /** The context field as typed, until the form is sent. */
  contextWindowText?: string;
};

/** What the context field shows: what is being typed, else the window the
 *  user declared earlier. Empty means "as detected". */
export function contextWindowTextOf(model: ModelDraft): string {
  if (model.contextWindowText !== undefined) return model.contextWindowText;
  return model.contextWindowDeclared && model.contextWindow ? formatContextWindow(model.contextWindow) : '';
}

/** How a model's thinking is set in the form: as detected, or by hand. */
export type ThinkingChoice = 'auto' | 'levels' | 'budget' | 'toggle' | 'none';

export function thinkingChoiceOf(model: ModelDraft): ThinkingChoice {
  if (model.supportedReasoningLevels?.length) return 'levels';
  return model.reasoningControl?.type ?? 'auto';
}

/** The model with `choice` declared, the other kind of declaration cleared. */
export function withThinkingChoice(model: ModelDraft, choice: ThinkingChoice, detail: { levels?: string[]; max?: number } = {}): ModelDraft {
  const { supportedReasoningLevels: _levels, reasoningControl: _control, ...rest } = model;
  if (choice === 'levels') return { ...rest, supportedReasoningLevels: detail.levels ?? model.supportedReasoningLevels ?? [] };
  if (choice === 'budget') {
    const max = 'max' in detail ? detail.max : model.reasoningControl?.type === 'budget' ? model.reasoningControl.max : undefined;
    return { ...rest, reasoningControl: { type: 'budget', ...(max !== undefined ? { max } : {}) } };
  }
  if (choice === 'toggle' || choice === 'none') return { ...rest, reasoningControl: { type: choice } };
  return rest;
}

/** Level names typed as a list: commas or spaces between them. */
export function parseLevels(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((level) => level.trim()).filter(Boolean))].slice(0, 12);
}

/**
 * What applies to the model as the form holds it: a declaration it carries,
 * else what was detected (or, before the first save, the levels a Test
 * reported). Mirrors the daemon's order so the form can say which bar the
 * selectors will draw.
 */
export function effectiveReasoning(model: ModelDraft): ModelReasoning | undefined {
  const levels = model.supportedReasoningLevels;
  if (levels?.length) return { source: 'declared', thinks: true, controls: [{ type: 'levels', values: levels }] };
  const control = model.reasoningControl;
  if (control?.type === 'none') return { source: 'declared', thinks: false, controls: [] };
  if (control) return { source: 'declared', thinks: true, controls: [control.type === 'toggle' ? { type: 'toggle' } : { type: 'budget', ...(control.min !== undefined ? { min: control.min } : {}), ...(control.max !== undefined ? { max: control.max } : {}) }] };
  if (model.detectedReasoning) return model.detectedReasoning;
  const reported = model.reportedReasoningLevels;
  return reported ? { source: 'agent', thinks: true, controls: reported.length ? [{ type: 'levels', values: reported }] : [] } : undefined;
}

export type BackendForm = {
  /** `null` while adding. An id means the form EDITS that backend, and the
   *  key field then means "replace it", never "this is the key". */
  id: string | null;
  origin?: 'file' | 'builtin' | 'plugin';
  connectionEditable?: boolean;
  name: string;
  baseUrl: string;
  key: string;
  protocol: BackendProtocol;
  /** Typed in, or proposed by a successful test — never imposed by one. */
  models: ModelDraft[];
  /** Slugs the backend served when the form opened: what is missing from
   *  `models` at save time was deleted, and a built-in needs to be told so. */
  savedSlugs?: string[];
  defaultModel: string | null;
  icon: string | null;
  brand: string | null;
};

export type CustomBackend = {
  id: string;
  file: string | null;
  origin?: 'file' | 'builtin' | 'plugin';
  disabled?: boolean;
  rank?: number;
  usages?: { agents: { id: string; label: string }[]; routines: { id: string; label: string }[]; tasks: { id: string; label: string }[] };
  label: string;
  dialect: string | null;
  protocol: BackendProtocol | null;
  baseUrl: string | null;
  models: ModelDraft[];
  defaultModel: string | null;
  icon: string | null;
  brand: string | null;
  hasVaultKey: boolean;
  active: boolean;
  reason: string | null;
  warnings: string[];
};

export type TestOutcome =
  | { outcome: 'ok'; status: number; models: string[]; reasoningLevels?: Record<string, string[]> }
  | { outcome: 'key-refused'; status: number }
  | { outcome: 'unreachable' }
  | { outcome: 'unexpected-status'; status: number };

export function blankForm(): BackendForm {
  return { id: null, name: '', baseUrl: '', key: '', protocol: 'anthropic', models: [], defaultModel: null, icon: null, brand: null };
}

/** A ready-made provider: the form opens prefilled, the user completes and saves it. */
export type BackendPreset = {
  id: string;
  /** Written as the provider's name. */
  name: string;
  /** i18n key of the preset button. */
  labelKey: string;
  protocol: BackendProtocol;
  baseUrl: string;
  models: readonly { slug: string; label: string }[];
  brand: string | null;
};

/**
 * The two providers most local installs want, in one click:
 *  - oMLX, an OpenAI-shaped MLX server on Apple Silicon (serves `/v1/responses`);
 *  - the DeepSeek hosted API, through its Anthropic-compatible endpoint.
 * Base URLs stay editable: a non-default port or proxy is common.
 */
export const BACKEND_PRESETS: readonly BackendPreset[] = Object.freeze([
  {
    id: 'omlx',
    name: 'oMLX',
    labelKey: 'backendsSettings.presets.omlx',
    protocol: 'openai-responses',
    baseUrl: 'http://127.0.0.1:8000/v1',
    models: [],
    brand: null,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek API',
    labelKey: 'backendsSettings.presets.deepseek',
    protocol: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [
      { slug: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
      { slug: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
    brand: 'deepseek',
  },
]);

/** The form of a preset: same fields as "Add", filled in. */
export function presetForm(preset: BackendPreset): BackendForm {
  return {
    ...blankForm(),
    name: preset.name,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    models: preset.models.map((model) => ({ slug: model.slug, label: model.label })),
    defaultModel: preset.models[0]?.slug ?? null,
    brand: preset.brand,
  };
}

/** Reopens a saved backend for editing. The key is left empty on purpose: we
 *  never receive it back, and an empty field means "leave it alone". */
export function formOf(backend: CustomBackend): BackendForm {
  return {
    id: backend.id,
    origin: backend.origin ?? 'file',
    connectionEditable: !!backend.protocol && !!backend.baseUrl,
    name: backend.label,
    baseUrl: backend.baseUrl ?? '',
    key: '',
    protocol: backend.protocol ?? 'anthropic',
    models: backend.models.map((model) => ({ ...model, label: model.presetLabel ?? model.label })),
    savedSlugs: backend.models.map((model) => model.slug),
    defaultModel: backend.defaultModel,
    icon: backend.icon,
    brand: backend.brand,
  };
}

/** A slug typed twice would make two rows that cannot be told apart in a
 *  menu, and a blank one would be sent to the CLI as `--model ''`. */
export function modelsErrorKey(models: readonly ModelDraft[]): string | null {
  const slugs = models.map((model) => model.slug.trim());
  if (slugs.some((slug) => !slug)) return 'backendsSettings.errors.modelSlugRequired';
  if (new Set(slugs).size !== slugs.length) return 'backendsSettings.errors.modelDuplicate';
  if (models.some((model) => parseContextWindow(contextWindowTextOf(model)) === undefined)) {
    return 'backendsSettings.errors.contextWindowInvalid';
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Adds the slugs an endpoint listed to the models already named, and only
 * those: a test is a PROPOSAL. Overwriting here would erase the labels and the
 * pictures a user set, on a button they pressed to check their key.
 */
export function mergeDiscovered(models: readonly ModelDraft[], discovered: readonly string[], reported: Record<string, string[]> = {}): ModelDraft[] {
  const known = new Set(models.map((model) => model.slug.trim()));
  const fresh = discovered.filter((slug) => !known.has(slug)).map((slug): ModelDraft => ({ slug, label: slug }));
  // The effort levels the listing reported travel with the model, so the
  // daemon keeps them as the provider's own answer once the form is saved.
  return [...models, ...fresh].map((model) => {
    const levels = reported[model.slug.trim()];
    return levels ? { ...model, reportedReasoningLevels: [...levels] } : model;
  });
}

/** i18n key of what keeps the form from being sent, or null. */
export function formErrorKey(form: BackendForm): string | null {
  if (!form.name.trim()) return 'backendsSettings.errors.nameRequired';
  if ((!form.origin || form.origin === 'file') && form.connectionEditable !== false && !isHttpUrl(form.baseUrl.trim())) return 'backendsSettings.errors.urlInvalid';
  return modelsErrorKey(form.models);
}

/** Host the prompts will be sent to, for the notice under the address field. */
export function destinationHost(baseUrl: string): string | null {
  return isHttpUrl(baseUrl.trim()) ? new URL(baseUrl.trim()).host : null;
}

/** One declaration per model: the kind the form shows, the other cleared on
 *  an edit (`null`), so the file never keeps a choice the user replaced. */
function thinkingFields(model: ModelDraft, editing: boolean): Record<string, unknown> {
  const choice = thinkingChoiceOf(model);
  const levels = choice === 'levels' ? model.supportedReasoningLevels : undefined;
  const control = choice !== 'levels' ? model.reasoningControl : undefined;
  return {
    ...(levels?.length ? { supportedReasoningLevels: levels } : editing ? { supportedReasoningLevels: null } : {}),
    ...(control ? { reasoningControl: control } : editing ? { reasoningControl: null } : {}),
    ...(model.reportedReasoningLevels ? { reportedReasoningLevels: model.reportedReasoningLevels } : {}),
  };
}

/** The typed window, `null` on an edit to go back to the detected value. */
function contextWindowField(model: ModelDraft, editing: boolean): Record<string, unknown> {
  const tokens = parseContextWindow(contextWindowTextOf(model));
  if (tokens) return { contextWindow: tokens };
  return editing ? { contextWindow: null } : {};
}

function cleanModels(models: readonly ModelDraft[], editing = false, thinking = false): Record<string, unknown>[] {
  return models.map((model) => ({
    slug: model.slug.trim(),
    label: model.label.trim() || model.slug.trim(),
    ...(model.icon ? { icon: model.icon } : editing ? { icon: null } : {}),
    ...(model.brand ? { brand: model.brand } : editing ? { brand: null } : {}),
    ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
    ...contextWindowField(model, editing),
    ...(thinking ? thinkingFields(model, editing) : {}),
  }));
}

export function createPayload(form: BackendForm): Record<string, unknown> {
  const key = form.key.trim();
  return {
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    protocol: form.protocol,
    ...(key ? { key } : {}),
    ...(form.models.length ? { models: cleanModels(form.models, false, true) } : {}),
    ...(form.defaultModel ? { defaultModel: form.defaultModel } : {}),
    ...(form.icon ? { icon: form.icon } : {}),
    ...(form.brand ? { brand: form.brand } : {}),
  };
}

/**
 * What an edit sends. Everything the form holds goes, EXCEPT an empty key:
 * the field cannot be prefilled with a secret we never receive, so "empty"
 * can only mean "keep the one you have".
 */
export function updatePayload(form: BackendForm): Record<string, unknown> {
  if (form.origin && form.origin !== 'file') {
    const listed = new Set(form.models.map((model) => model.slug.trim()));
    const removedModels = (form.savedSlugs ?? []).filter((slug) => !listed.has(slug));
    return { label: form.name.trim(), models: cleanModels(form.models, true),
      ...(removedModels.length ? { removedModels } : {}),
      defaultModel: form.defaultModel, icon: form.icon, brand: form.brand };
  }
  const key = form.key.trim();
  return {
    name: form.name.trim(),
    ...(form.connectionEditable !== false ? { baseUrl: form.baseUrl.trim(), protocol: form.protocol, ...(key ? { key } : {}) } : {}),
    models: cleanModels(form.models, true, true),
    defaultModel: form.defaultModel,
    icon: form.icon,
    brand: form.brand,
  };
}

export function testPayload(form: BackendForm): Record<string, unknown> {
  const key = form.key.trim();
  return { protocol: form.protocol, baseUrl: form.baseUrl.trim(), ...(key ? { key } : {}) };
}

export function outcomeMessage(result: TestOutcome): { tone: 'ok' | 'warn' | 'error'; key: string; vars?: Record<string, string | number> } {
  switch (result.outcome) {
    case 'ok':
      return result.models.length
        ? { tone: 'ok', key: 'backendsSettings.test.okModels', vars: { count: result.models.length } }
        : { tone: 'ok', key: 'backendsSettings.test.ok' };
    case 'key-refused':
      return { tone: 'error', key: 'backendsSettings.test.keyRefused', vars: { status: result.status } };
    case 'unreachable':
      return { tone: 'error', key: 'backendsSettings.test.unreachable' };
    default:
      // A 404 on the model listing is the ordinary answer of a gateway that
      // only implements the completion endpoint — the Anthropic side of
      // DeepSeek, among others. Saying "unexpected status" there sends the
      // user hunting a fault that is not one: what they have to do is name
      // their models themselves.
      return result.status === 404
        ? { tone: 'warn', key: 'backendsSettings.test.noListing' }
        : { tone: 'warn', key: 'backendsSettings.test.unexpected', vars: { status: result.status } };
  }
}
