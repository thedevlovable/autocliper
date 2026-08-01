import { useState, useRef, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { Scissors, Loader2, AlertCircle, Sparkles, Mail, RefreshCw } from 'lucide-react';
import { useAuth, apiFetch } from '../lib/auth';
import type { AuthUser } from '../lib/auth';

function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && next.startsWith('/') ? next : '/';
}

export default function SignUp() {
  const { signup, refresh } = useAuth();
  const [, setLocation] = useLocation();

  // Step: 'form' | 'otp'
  const [step, setStep] = useState<'form' | 'otp'>('form');
  const [pendingEmail, setPendingEmail] = useState('');

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // OTP state — 6 separate digit inputs
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);

  // ── Submit signup form ──────────────────────────────────────────────────────
  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await signup(email, password, name || undefined);
      if ('needsVerification' in result && result.needsVerification) {
        setPendingEmail(result.email);
        setStep('otp');
      } else {
        setLocation(nextPath());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  };

  // ── OTP digit input handlers ────────────────────────────────────────────────
  const handleDigit = (i: number, val: string) => {
    const ch = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = ch;
    setDigits(next);
    if (ch && i < 5) digitRefs.current[i + 1]?.focus();
    // Auto-submit when all 6 digits filled
    if (ch && next.every(d => d !== '') && next.join('').length === 6) {
      verifyCode(next.join(''));
    }
  };

  const handleDigitKey = (i: number, key: string) => {
    if (key === 'Backspace' && !digits[i] && i > 0) {
      digitRefs.current[i - 1]?.focus();
    }
  };

  const handleDigitPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      const next = pasted.split('');
      setDigits(next);
      digitRefs.current[5]?.focus();
      verifyCode(pasted);
    }
  };

  // ── Verify OTP ───────────────────────────────────────────────────────────────
  const verifyCode = async (code: string) => {
    if (otpBusy) return;
    setOtpBusy(true);
    setOtpError('');
    try {
      const d = await apiFetch<{ user: AuthUser }>('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      await refresh();
      void d;
      setLocation(nextPath());
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : 'Verification failed.');
      setDigits(['', '', '', '', '', '']);
      digitRefs.current[0]?.focus();
    } finally {
      setOtpBusy(false);
    }
  };

  const submitOtp = (e: FormEvent) => {
    e.preventDefault();
    const code = digits.join('');
    if (code.length === 6) verifyCode(code);
  };

  // ── Resend code ──────────────────────────────────────────────────────────────
  const resendCode = async () => {
    if (resendCooldown > 0) return;
    try {
      await apiFetch('/auth/resend-verification', { method: 'POST' });
      setResendCooldown(60);
      const t = setInterval(() => {
        setResendCooldown(c => { if (c <= 1) { clearInterval(t); return 0; } return c - 1; });
      }, 1000);
    } catch (err) {
      setOtpError(err instanceof Error ? err.message : 'Could not resend code.');
    }
  };

  // ── OTP screen ───────────────────────────────────────────────────────────────
  if (step === 'otp') {
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
            <div className="flex justify-center mb-4">
              <div className="w-12 h-12 rounded-2xl bg-[#D1FE17]/10 border border-[#D1FE17]/20 flex items-center justify-center">
                <Mail className="w-6 h-6 text-[#D1FE17]" />
              </div>
            </div>
            <h1 className="text-white font-black text-2xl text-center">Check your email</h1>
            <p className="text-white/50 text-sm text-center mt-2">
              We sent a 6-digit code to<br />
              <span className="text-white font-semibold">{pendingEmail}</span>
            </p>

            {otpError && (
              <div className="mt-5 flex items-start gap-2.5 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-red-400 text-sm">{otpError}</p>
              </div>
            )}

            <form onSubmit={submitOtp} className="mt-6">
              {/* 6-digit boxes */}
              <div className="flex gap-2 justify-center" onPaste={handleDigitPaste}>
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={el => { digitRefs.current[i] = el; }}
                    type="text"
                    inputMode="numeric"
                    maxLength={1}
                    value={d}
                    onChange={e => handleDigit(i, e.target.value)}
                    onKeyDown={e => handleDigitKey(i, e.key)}
                    disabled={otpBusy}
                    className="w-12 h-14 text-center text-2xl font-black bg-[#222] border border-white/10 rounded-xl text-white outline-none focus:border-[#D1FE17]/60 transition-colors disabled:opacity-50"
                    autoFocus={i === 0}
                  />
                ))}
              </div>

              <button
                type="submit"
                disabled={otpBusy || digits.join('').length < 6}
                className="w-full mt-5 bg-[#D1FE17] text-black font-black rounded-xl py-3 hover:bg-[#c5f010] active:scale-[0.99] transition-all disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {otpBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                Verify & activate account
              </button>
            </form>

            <div className="mt-5 text-center">
              <button
                onClick={resendCode}
                disabled={resendCooldown > 0}
                className="inline-flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 disabled:opacity-40 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
              </button>
            </div>

            <p className="text-white/30 text-xs text-center mt-4">
              Wrong email?{' '}
              <button onClick={() => setStep('form')} className="text-white/50 hover:text-white underline">
                Go back
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Signup form ──────────────────────────────────────────────────────────────
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

          <form onSubmit={submitForm} className="mt-6 space-y-4">
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
