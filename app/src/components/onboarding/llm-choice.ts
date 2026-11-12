/**
 * The "Choose your LLM" step, pure (docs/ONBOARDING-LLM.md): which block is
 * shown under the fixed header, and what the subscription block says and
 * allows from the provider list the daemon answered.
 */
import { BRAND } from '@/lib/brand';
import { providerCliState, readyForSetupChat, type ProviderCli } from '@/lib/provider-clis';

/** The block under the header: the choices, the provider cards, the local models, or a web API. */
export type LlmView = 'choose' | 'plan' | 'local' | 'web';

/**
 * What "Back" does on this step: from a block back to the two choices, on
 * the same screen; from the choices, the previous step.
 */
export function llmBack(view: LlmView): LlmView | null {
  return view === 'choose' ? null : 'choose';
}

/**
 * The provider list as the subscription block received it: `undefined` while
 * the daemon has not answered, `null` when it refused or could not be reached.
 */
export type ProviderAnswer = readonly ProviderCli[] | null | undefined;

export type PlanStatus = {
  /** "Continue" is enabled. */
  canContinue: boolean;
  /** "Continue anyway" shows: no AI the chat can start on, and the list is known. */
  anyway: boolean;
  /** The line above "Continue". */
  line: { kind: 'ready'; names: string[] } | { kind: 'none' } | null;
};

/**
 * The CLIs "Ready with …" names: those the chat can start on, by the same
 * rule as `readyForSetupChat`, so the line never names a CLI "Continue" does
 * not count. The ones known to be signed in come first.
 */
export function readyNames(backends: readonly ProviderCli[]): string[] {
  const ready = backends.filter((cli) => cli.seedsMainAgent && cli.path !== null && cli.signedIn !== false);
  const signedIn = ready.filter((cli) => providerCliState(cli) === 'ready');
  const unsure = ready.filter((cli) => providerCliState(cli) !== 'ready');
  return [...signedIn, ...unsure].map((cli) => cli.label);
}

/**
 * What the "subscription" choice names and shows, from the same list as the
 * provider cards (`/api/ui/backends/provider-clis`, the providers' own
 * declarations): the CLIs the chat can start on, in the daemon's order, and
 * each brand once. Written by hand, the line named a provider Timon has no CLI
 * for; read from the daemon, it follows the providers a build ships.
 */
export function subscriptionProviders(backends: readonly ProviderCli[]): { names: string[]; brands: string[] } {
  const usable = backends.filter((cli) => cli.seedsMainAgent);
  const brands = [...new Set(usable.map((cli) => cli.brand).filter((brand): brand is string => !!brand))];
  return { names: usable.map((cli) => cli.label), brands };
}

/**
 * A list refused or unreachable does not hold the onboarding (as on
 * `/setup/agent`): the chat says itself what is missing.
 */
export function planStatus(answer: ProviderAnswer): PlanStatus {
  if (answer === undefined) return { canContinue: false, anyway: false, line: null };
  if (answer === null) return { canContinue: true, anyway: false, line: null };
  if (readyForSetupChat(answer)) return { canContinue: true, anyway: false, line: { kind: 'ready', names: readyNames(answer) } };
  return { canContinue: false, anyway: true, line: { kind: 'none' } };
}

/** Under the two choices. The terms page is the product site's; the privacy notice is the public docs' one, as in Settings › Privacy. */
export const LEGAL_LINKS = {
  terms: `https://${BRAND.domain}/terms`,
  privacy: `https://docs.${BRAND.domain}/usage/privacy`,
} as const;

/** A product name, the same in every language. */
export const OLLAMA_NAME = 'Ollama';

/** Ollama's own download page: Timon does not install it, nor run its installer. */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/**
 * A message with links in it: the translated sentence is cut at its
 * placeholders, so each link keeps its own translated label wherever the
 * language puts it.
 */
export type TextPart = { kind: 'text'; text: string } | { kind: 'slot'; name: string };

const MARK = '\u0000';

export function splitAtSlots(render: (vars: Record<string, string>) => string, names: readonly string[]): TextPart[] {
  const vars = Object.fromEntries(names.map((name) => [name, `${MARK}${name}${MARK}`]));
  const parts = render(vars).split(MARK);
  return parts.flatMap((piece, i): TextPart[] => {
    if (i % 2 === 1 && names.includes(piece)) return [{ kind: 'slot', name: piece }];
    return piece ? [{ kind: 'text', text: piece }] : [];
  });
}
