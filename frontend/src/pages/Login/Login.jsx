import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useAuthStore from '../../store/authStore';
import { apiUrl } from '../../lib/apiUrl';
import StoreLoginButton from '../../components/StoreLoginButton';

// A page with a highlighted line and a pencil note — what the app is for, drawn in CSS.
function PageArt() {
  return (
    <div className="relative mx-auto h-72 w-56 -rotate-3 rounded-md bg-[#f5ebd4] p-5 shadow-cover">
      <div className="space-y-2.5">
        {[88, 100, 94, 72].map((w, i) => (
          <div key={i} className="h-1.5 rounded-full bg-[#3c3022]/25" style={{ width: `${w}%` }} />
        ))}
        <div className="relative h-4">
          <div className="absolute inset-y-0 left-0 w-[92%] rounded-sm bg-[#ffd84d]/80 mix-blend-multiply" />
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[#3c3022]/30" style={{ width: '92%' }} />
        </div>
        {[100, 84, 96].map((w, i) => (
          <div key={i} className="h-1.5 rounded-full bg-[#3c3022]/25" style={{ width: `${w}%` }} />
        ))}
      </div>
      <svg viewBox="0 0 160 70" className="absolute bottom-5 left-4 w-40 text-accent" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 44 C 20 14, 34 14, 40 40 S 58 62, 68 30 S 92 10, 100 38 S 124 58, 150 20" />
        <path d="M120 60 C 132 54, 146 54, 156 58" opacity=".6" />
      </svg>
    </div>
  );
}

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        const res = await fetch(apiUrl('/api/auth/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Sign up failed');
        }
        await useAuthStore.getState().checkSession();
      }
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const field = 'rounded-xl border border-neutral-300 bg-transparent px-4 py-3 outline-none transition focus:border-accent focus:shadow-[0_0_0_3px_theme(colors.accent.soft)] dark:border-neutral-600 dark:focus:shadow-[0_0_0_3px_rgb(124_58_237/0.25)]';

  return (
    <div className="flex min-h-full bg-neutral-50 dark:bg-neutral-950">
      <aside className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-[#4c1d95] via-[#6d28d9] to-[#8b5cf6] p-12 text-white lg:flex">
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute -bottom-32 left-10 h-96 w-96 rounded-full bg-[#ffd84d]/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <img src="/logo.png" alt="" className="h-10 w-10 rounded-xl shadow-float" />
          <span className="font-serif text-2xl font-semibold tracking-tight">Quarc Reader</span>
        </div>
        <div className="relative">
          <PageArt />
        </div>
        <div className="relative max-w-md">
          <p className="font-serif text-4xl font-semibold leading-tight">{t('auth.tagline')}</p>
          <p className="mt-4 text-white/75">{t('auth.taglineBody')}</p>
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <img src="/logo.png" alt="Quarc Reader" className="h-16 w-16 rounded-2xl shadow-float lg:hidden" />
            <h1 className="font-serif text-3xl font-semibold tracking-tight">{t('auth.signInToAccount')}</h1>
          </div>
          <StoreLoginButton
            onSignedIn={async () => {
              await useAuthStore.getState().checkSession();
              navigate('/');
            }}
          />
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input className={field} placeholder={t('auth.username')} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoCapitalize="none" autoCorrect="off" />
            <input className={field} placeholder={t('auth.password')} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button type="submit" disabled={busy} className="mt-2 rounded-full bg-accent px-4 py-3 font-medium text-white shadow-soft transition hover:bg-accent-dark active:scale-[0.98] disabled:opacity-50">
              {mode === 'login' ? t('auth.login') : t('auth.signup')}
            </button>
          </form>
          <button className="mt-5 w-full text-center text-sm text-neutral-500 hover:text-accent hover:underline" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? t('auth.needAccount') : t('auth.haveAccount')}
          </button>
        </div>
      </main>
    </div>
  );
}
