import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Scissors, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../lib/auth';

function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') ? next : '/';
}

export default function Login() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      setLocation(nextPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="flex justify-center mb-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-[#D1FE17] flex items-center justify-center">
              <Scissors className="w-5 h-5 text-black" strokeWidth={2.5} />
            </div>
            <span className="font-black text-xl tracking-tight text-white">AutoCliper</span>
          </Link>
        </div>

        <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-8">
          <h1 className="text-white font-black text-2xl text-center">Welcome back</h1>
          <p className="text-white/50 text-sm text-center mt-1.5">Log in to keep clipping</p>

          {error && (
            <div className="mt-5 flex items-start gap-2.5 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="block text-white/70 text-sm font-medium mb-1.5">Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@gmail.com"
                className="w-full bg-[#222] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/50 transition-colors"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-white/70 text-sm font-medium">Password</label>
                <Link
                  href="/reset-password"
                  className="text-[#D1FE17] hover:text-[#c5f010] text-sm font-semibold"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-[#222] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/50 transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-[#D1FE17] text-black font-black rounded-xl py-3 hover:bg-[#c5f010] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Log in
            </button>
          </form>

          <p className="text-white/40 text-sm text-center mt-6">
            New here?{' '}
            <Link href="/signup" className="text-[#D1FE17] hover:text-[#c5f010] font-semibold">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
