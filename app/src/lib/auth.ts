import { readJsonObject } from './json-response';
import { sharedGet } from '@/lib/shared-read';
import { parseActingAccount, parseCan, type ActingAccount, type ActingUser } from './machines/acting-account';

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  status: string;
  is_superadmin: boolean;
  created_at: number;
  last_login_at: number | null;
  /** Uploaded picture, `null` when the avatar has to fall back to initials. */
  avatar_url: string | null;
};

export type ColorScheme = 'light' | 'dark';

export type UserPrefs = {
  theme: string;
  layout: string;
  scheme: ColorScheme;
};

/**
 * Product defaults when `/api/auth/me` has no row for the caller.
 * Source of truth: `DEFAULT_USER_PREFS` in `orchestrator/src/db.ts`.
 * The two packages do not import each other — keep this copy aligned.
 */
export const DEFAULT_USER_PREFS: UserPrefs = {
  // The Timon theme since 0.1.7; the accounts made before keep their row.
  theme: 'theme-timon',
  layout: '@timon/ui-layout',
  scheme: 'dark',
};

/** The permissions `/api/auth/me` answers for the caller. Source of truth:
 *  `ME_CAN_PERMISSIONS` in `orchestrator/src/plugins-bundled/users/routes.ts`. */
export type MePermission = 'projects:manage' | 'agents:manage' | 'agents:privileged-config';

export type AuthMe = {
  user: PublicUser | null;
  needsSetup: boolean;
  setupRequiresLicense?: boolean;
  /** An exposed install asks for the one-time token `timon setup-token` prints. */
  setupRequiresToken?: boolean;
  /** The first account confirms its email with a mailed code. `false` when the
   *  operator turned that off for a local install (`TIMON_SETUP_EMAIL_CODE=0`). */
  setupRequiresEmailCode?: boolean;
  prefs: UserPrefs;
  /** `null`: a daemon older than the field, which did not say (TODO #560).
   *  The ACTIVE machine's: on a remote one, the acting account's. */
  can: Partial<Record<MePermission, boolean>> | null;
  /** Set while a remote machine is active: who this computer acts as there
   *  (`lib/machines/acting-account.ts`). `user` stays the local session's. */
  acting: ActingAccount | null;
  /** The upgrade welcome (docs/ONBOARDING.md, `Upgrade welcome`): `returning`
   *  to a signed-out browser while an account made before the new onboarding
   *  has to sign in again, `mascot` to that account once signed in. Absent on
   *  a daemon older than the field: nothing to show. */
  welcome?: MeWelcome;
};

export type MeWelcome = 'returning' | 'mascot' | null;

function parseWelcome(raw: unknown): MeWelcome {
  return raw === 'returning' || raw === 'mascot' ? raw : null;
}

function coercePrefs(raw: unknown): UserPrefs {
  const prefs = raw && typeof raw === 'object' ? raw as { theme?: unknown; layout?: unknown; scheme?: unknown } : {};
  return {
    theme: typeof prefs.theme === 'string' ? prefs.theme : DEFAULT_USER_PREFS.theme,
    layout: typeof prefs.layout === 'string' ? prefs.layout : DEFAULT_USER_PREFS.layout,
    scheme: prefs.scheme === 'light' ? 'light' : 'dark',
  };
}

/**
 * The account objects of the active machine are measured against: "is this
 * mission mine", "may I open the users page". The acting account on a remote
 * machine (`null` while it could not say), the local one otherwise. The
 * avatar menu, the profile and the session keep `me.user`: `/api/auth/*`
 * never leaves this computer.
 */
export function actingUser(me: AuthMe | null): ActingUser | null {
  if (!me) return null;
  return me.acting ? me.acting.user : me.user;
}

/**
 * May the signed-in account do this? Only greys a control: the route is what
 * refuses. `null` while the account is still being read — a control stays
 * disabled, but says nothing yet. A daemon too old to say is yes: greying
 * every button of an older machine would be wrong for its admin, and its
 * route answers for itself.
 */
export function meCan(me: AuthMe | null, permission: MePermission): boolean | null {
  if (!me) return null;
  if (me.can === null) return true;
  return me.can[permission] === true;
}

export async function fetchMe(): Promise<AuthMe> {
  const response = await sharedGet('/api/ui/auth/me');
  if (!response.ok) return { user: null, needsSetup: false, prefs: { ...DEFAULT_USER_PREFS }, can: {}, acting: null };
  const body = await readJsonObject(response, '/api/ui/auth/me') as { user?: PublicUser | null; needsSetup?: boolean; setupRequiresLicense?: boolean; setupRequiresToken?: boolean; setupRequiresEmailCode?: boolean; prefs?: unknown; can?: unknown; acting?: unknown; welcome?: unknown };
  return readAuthMe(body);
}

/** A `/api/ui/auth/me` body, typed. On a remote machine the permissions are
 *  the acting account's — the routes they grey are relayed there — and none
 *  while that machine has not said who the device is. */
export function readAuthMe(body: { user?: PublicUser | null; needsSetup?: boolean; setupRequiresLicense?: boolean; setupRequiresToken?: boolean; setupRequiresEmailCode?: boolean; prefs?: unknown; can?: unknown; acting?: unknown; welcome?: unknown }): AuthMe {
  const acting = parseActingAccount(body.acting);
  return {
    user: body.user ?? null,
    needsSetup: body.needsSetup === true,
    setupRequiresLicense: body.setupRequiresLicense !== false,
    setupRequiresToken: body.setupRequiresToken === true,
    setupRequiresEmailCode: body.setupRequiresEmailCode !== false,
    prefs: coercePrefs(body.prefs),
    can: acting ? (acting.user ? acting.can : {}) : parseCan(body.can),
    acting,
    welcome: parseWelcome(body.welcome),
  };
}

const LOGIN_PATH = '/login';
const INVITE_PATH = '/invite';
/** Followed from a mail client, which carries no session cookie of ours — the
 *  token in the URL is the whole credential. */
const CONFIRM_EMAIL_PATH = '/confirm-email';
/** The onboarding's welcome and account steps come before any account exists:
 *  the page itself holds no data, and every route its later steps call checks
 *  the session on its own. */
const ONBOARDING_PATH = '/onboarding';

export function isLoginPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);
}

export function isInvitePath(pathname: string): boolean {
  return pathname === INVITE_PATH || pathname.startsWith(`${INVITE_PATH}/`);
}

export function isConfirmEmailPath(pathname: string): boolean {
  return pathname === CONFIRM_EMAIL_PATH || pathname.startsWith(`${CONFIRM_EMAIL_PATH}/`);
}

export function isOnboardingPath(pathname: string): boolean {
  return pathname === ONBOARDING_PATH || pathname.startsWith(`${ONBOARDING_PATH}/`);
}

/** Document routes that must not render without a session cookie. */
export function pageRequiresLogin(pathname: string): boolean {
  if (isLoginPath(pathname)) return false;
  if (isInvitePath(pathname)) return false;
  if (isConfirmEmailPath(pathname)) return false;
  if (isOnboardingPath(pathname)) return false;
  if (pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/_next/')) return false;
  return true;
}

/**
 * A 401 from the UI proxy means the browser has no live session. Auth
 * endpoints stay: a bad password is a 401 we must not treat as signed-out.
 */
export function shouldRedirectOn401(pathname: string, apiPath: string): boolean {
  if (isLoginPath(pathname) || isInvitePath(pathname) || isConfirmEmailPath(pathname) || isOnboardingPath(pathname)) return false;
  if (!apiPath.startsWith('/api/ui/')) return false;
  if (apiPath.startsWith('/api/ui/auth/')) return false;
  return true;
}
