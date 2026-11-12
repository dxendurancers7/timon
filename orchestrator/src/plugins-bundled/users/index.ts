/**
 * Module `@timon/users` — accounts, sessions, and the login/setup routes.
 * Tier `core` since 05/11/2026: the person's own account cannot be switched
 * off. Administering several accounts (invitations, roles, groups, the audit
 * log) is the Multi-user plugin's, through the account provider seam.
 *
 * The legacy daemon-token still authenticates as superadmin for the CLI
 * and MCP (operator access). Spawned agents receive a per-mission
 * `api_tokens` row instead (`docs/MULTI-USER.md` §6).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { BUNDLED_USER_ROUTES, registerRoutes } from './routes.js';
import { registerDeviceRoutes } from '../../users/devices-http.js';
import { recordExistingAppearance } from '../../appearance.js';
import { DEVICE_CONNECTION_SWEEP_MS } from '../../users/device-connections.js';
import { sweepDeviceConnections } from '../../users/devices.js';

export const manifest: ModuleManifest = {
  name: '@timon/users',
  tier: 'core',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // A local install can opt out of the first account's emailed confirmation code
  // (`TIMON_SETUP_EMAIL_CODE=0`): no mail relay is reachable offline. The
  // daemon-token operator path already skips it; this lets the web onboarding
  // create the account too.
  const emailVerification = process.env.TIMON_SETUP_EMAIL_CODE !== '0';
  registerRoutes(ctx.http.router(), { ...BUNDLED_USER_ROUTES, emailVerification });
  registerDeviceRoutes(ctx.http.router());
  // A device that expires or loses its owner while a terminal or an event
  // stream is open loses it too (revocation closes them at once).
  ctx.effect(() => {
    const timer = setInterval(() => { sweepDeviceConnections(); }, DEVICE_CONNECTION_SWEEP_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  recordExistingAppearance();
  console.warn('[users] daemon-token remains CLI/operator superadmin; agents receive a per-mission api_token');
}
