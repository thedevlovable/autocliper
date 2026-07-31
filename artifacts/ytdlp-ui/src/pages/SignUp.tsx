import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Scissors, Loader2, AlertCircle, Sparkles } from 'lucide-react';
import { useAuth } from '../lib/auth';

function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') ? next : '/';
}

export default function SignUp() {
  const { signup } = useAuth();
  const [, setLocation] = useLocation();
  const [name, setName] = useState('');
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
      await signup(email, password, name || undefined);
      setLocation(nextPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.');
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
          <h1 className="text-white font-black text-2xl text-center">Create your account</h1>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <Sparkles className="w-3.5 h-3.5 text-[#D1FE17]" />
            <p className="text-white/50 text-sm">Start with 3 free clips — no card needed</p>
          </div>

          {error && (
            <div className="mt-5 flex items-start gap-2.5 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="block text-white/70 text-sm font-medium mb-1.5">Name <span className="text-white/30">(optional)</span></label>
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name"
                className="w-full bg-[#222] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/50 transition-colors"
              />
            </div>
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
              <label className="block text-white/70 text-sm font-medium mb-1.5">Password</label>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                className="w-full bg-[#222] border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/25 outline-none focus:border-[#D1FE17]/50 transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-[#D1FE17] text-black font-black rounded-xl py-3 hover:bg-[#c5f010] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Create account
            </button>
          </form>

          <p className="text-white/40 text-sm text-center mt-6">
            Already have an account?{' '}
            <Link href="/login" className="text-[#D1FE17] hover:text-[#c5f010] font-semibold">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
