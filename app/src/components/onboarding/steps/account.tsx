'use client';

/**
 * "Create your local account" (mockup screen `account`, docs/EMAIL-CODE-UI.md):
 * one column — first name, email, password twice — then the code the email
 * received, and the account exists only once that code is accepted. The
 * password never leaves this machine; the email goes to the Timon server, which
 * mails the code (docs/EMAIL-CODES.md).
 *
 * Laid out to fit 1366×768 without scrolling: the inputs are 40 px, the hints
 * one line, the privacy note under the button.
 */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { ArrowRight, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { PasswordInput } from '@/components/auth/password-input';
import { accountName, looksLikeEmail, passwordPairReady, passwordProblem, MIN_PASSWORD } from '@/components/auth/auth-form';
import { EmailCodeHost, useNow, type EmailCodeResent, type EmailCodeVerdict } from '@/components/email-code/email-code';
import {
  createAccount, requestSetupCode, resendSetupCode, RESTART_CODES, type CodeChallenge,
} from '@/components/email-code/email-code-api';
import { expiredChallenge, failureText, type CodeFailure } from '@/components/email-code/email-code-failure';
import { fetchMe } from '@/lib/auth';
import { firstRunScheme } from '@/lib/first-run-gate';
import { t } from '@/lib/i18n';
import { useOnboarding, useOnboardingBack } from '../onboarding-context';

/** The mockup's blue round head: the reader's own, before any agent exists. */
const LOOK = { shape: 'round', color: '#3fa9ff', eyes: 'big' } as const;

export type AccountDraft = { name: string; email: string; password: string; confirm: string; setupToken: string };

const EMPTY: AccountDraft = { name: '', email: '', password: '', confirm: '', setupToken: '' };

function Field({ id, label, required = false, hint, children }: { id: string; label: string; required?: boolean; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 ml-0.5 block text-[12.5px] font-semibold text-muted-foreground">
        {label}
        {required && <span aria-hidden className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p id={`${id}-hint`} className="ml-0.5 mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AccountStep(): ReactElement {
  const { next, goTo } = useOnboarding();
  const ids = useId();
  const now = useNow();
  const [draft, setDraft] = useState<AccountDraft>(EMPTY);
  const [shown, setShown] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  // A local install can create the first account without the mailed code
  // (`TIMON_SETUP_EMAIL_CODE=0`): the daemon says so on `/api/auth/me`.
  const [offlineSetup, setOfflineSetup] = useState(false);
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [view, setView] = useState<'form' | 'code'>('form');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<CodeFailure | null>(null);

  // An account already made (a reload after creating it) moves on; an install
  // that has one but no session signs in from the onboarding.
  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => {
      if (!alive) return;
      if (me.user) next();
      else if (!me.needsSetup) goTo('signin');
      else {
        setNeedsToken(me.setupRequiresToken === true);
        setOfflineSetup(me.setupRequiresEmailCode === false);
      }
    });
    return () => { alive = false; };
  }, [next, goTo]);

  // "Back" on the code returns to the form, filled as it was left.
  useOnboardingBack(() => {
    if (view !== 'code') return false;
    setView('form');
    return true;
  });

  const set = (field: keyof AccountDraft) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const email = draft.email.trim();
  const problem = passwordProblem(draft.password, draft.confirm);
  const waiting = failureText(failure, now);
  const ready = looksLikeEmail(email) && passwordPairReady(draft.password, draft.confirm) && (!needsToken || draft.setupToken.trim() !== '');
  const blocked = failure?.retryUntil != null && waiting !== null;

  const ask = useCallback(async (): Promise<CodeChallenge | CodeFailure> => {
    const answer = await requestSetupCode({ email, setupToken: needsToken ? draft.setupToken.trim() : undefined });
    return answer.ok ? answer.value : answer.failure;
  }, [email, draft.setupToken, needsToken]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || sending || blocked) return;
    setSending(true);
    setFailure(null);
    // Offline/local install: the account is created directly, with no mailed code.
    if (offlineSetup) {
      const scheme = firstRunScheme();
      const answer = await createAccount({
        email,
        name: accountName(draft.name, email),
        password: draft.password,
        ...(scheme ? { scheme } : {}),
        ...(needsToken ? { setupToken: draft.setupToken.trim() } : {}),
        challengeId: '',
        code: '',
      });
      setSending(false);
      if (answer.ok) next();
      else setFailure(answer.failure);
      return;
    }
    const answer = await ask();
    setSending(false);
    if ('challengeId' in answer) {
      setChallenge(answer);
      setView('code');
    } else {
      setFailure(answer);
    }
  };

  const verify = useCallback(async (code: string): Promise<EmailCodeVerdict> => {
    if (!challenge) return { ok: false, failure: expiredChallenge() };
    // The switch's choice, else the OS: the account keeps the mode the onboarding showed.
    const scheme = firstRunScheme();
    const answer = await createAccount({
      email,
      name: accountName(draft.name, email),
      password: draft.password,
      ...(scheme ? { scheme } : {}),
      ...(needsToken ? { setupToken: draft.setupToken.trim() } : {}),
      challengeId: challenge.challengeId,
      code,
    });
    return answer.ok ? { ok: true } : { ok: false, failure: answer.failure };
  }, [challenge, email, draft.name, draft.password, draft.setupToken, needsToken]);

  const resend = useCallback(async (): Promise<EmailCodeResent> => {
    if (!challenge) return { ok: false, failure: expiredChallenge() };
    const answer = await resendSetupCode(challenge.challengeId);
    if (answer.ok) return { ok: true, resendAt: answer.value.resendAt };
    // A challenge that can no longer send gives way to a new one.
    if (answer.failure.code && RESTART_CODES.has(answer.failure.code)) {
      const fresh = await ask();
      if (!('challengeId' in fresh)) return { ok: false, failure: fresh };
      setChallenge(fresh);
      return { ok: true, resendAt: fresh.resendAt };
    }
    return { ok: false, failure: answer.failure };
  }, [challenge, ask]);

  const changeEmail = useCallback(() => setView('form'), []);

  if (view === 'code' && challenge) {
    return (
      <EmailCodeHost
        purpose="verify"
        email={email}
        resendAt={challenge.resendAt}
        verify={verify}
        resend={resend}
        onVerified={next}
        changeEmail={changeEmail}
      />
    );
  }

  const line = waiting ?? (problem === 'mismatch' ? t('onboarding.account.mismatch') : problem === 'short' ? t('onboarding.account.tooShort', { min: MIN_PASSWORD }) : null);
  const toggle = () => setShown((s) => !s);

  return (
    <div className="flex w-full max-w-[440px] flex-col items-center text-center">
      <AgentMascotHost look={LOOK} size={56} />
      <h1 className="mt-2 text-[28px] font-bold leading-tight tracking-[-0.02em]">{t('onboarding.account.title')}</h1>
      <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{t('onboarding.account.subtitle')}</p>
      <form noValidate aria-busy={sending} className="mt-[18px] flex w-full flex-col gap-2.5 text-left" onSubmit={(e) => { void submit(e); }}>
        <Field id={`${ids}-name`} label={t('onboarding.account.name')} hint={t('onboarding.account.nameHint')}>
          <Input
            id={`${ids}-name`}
            autoFocus
            autoComplete="given-name"
            value={draft.name}
            onChange={set('name')}
            aria-describedby={`${ids}-name-hint`}
            className="h-10"
          />
        </Field>
        <Field id={`${ids}-email`} label={t('onboarding.account.email')} required hint={t('onboarding.account.emailHint')}>
          <Input
            id={`${ids}-email`}
            type="email"
            required
            autoComplete="username"
            placeholder={t('onboarding.account.emailPlaceholder')}
            value={draft.email}
            onChange={set('email')}
            aria-describedby={`${ids}-email-hint`}
            className="h-10"
          />
        </Field>
        <Field id={`${ids}-password`} label={t('onboarding.account.password')} required>
          <PasswordInput
            id={`${ids}-password`}
            required
            autoComplete="new-password"
            value={draft.password}
            onChange={set('password')}
            shown={shown}
            onToggleShown={toggle}
            className="h-10"
          />
        </Field>
        <Field id={`${ids}-confirm`} label={t('onboarding.account.confirm')} required>
          <PasswordInput
            id={`${ids}-confirm`}
            required
            autoComplete="new-password"
            value={draft.confirm}
            onChange={set('confirm')}
            shown={shown}
            onToggleShown={toggle}
            aria-invalid={problem !== null}
            className="h-10"
          />
        </Field>
        {needsToken && (
          <Field id={`${ids}-token`} label={t('loginPage.setupToken')} required>
            <Input
              id={`${ids}-token`}
              type="password"
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.setupToken}
              onChange={set('setupToken')}
              className="h-10"
            />
            <p className="ml-0.5 mt-1 text-xs text-muted-foreground">
              {t('loginPage.setupTokenHint')}{' '}
              {/* code-font: a command to type in a terminal */}
              <code className="rounded bg-muted px-1 py-0.5 text-[11.5px] text-foreground">timon setup-token</code>
            </p>
          </Field>
        )}
        <p role="status" aria-live="polite" data-account-status="" className="ml-0.5 min-h-4 text-[12.5px] leading-4 tabular-nums text-destructive">
          {line}
        </p>
        <Button type="submit" size="lg" className="h-11 w-full gap-2 rounded-full" disabled={!ready || sending || blocked}>
          {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t('onboarding.account.create')}
          {!sending && <ArrowRight className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
      <p className="mt-4 flex items-start gap-2 text-left text-[12.5px] leading-[1.45] text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('onboarding.account.privacy')}</span>
      </p>
    </div>
  );
}
