// YouTube cookies panel — lets the site owner connect a signed-in YouTube
// session so caption downloads and bot-checked videos work reliably.
//
// Backend contract (routes/cookies.ts on the API server):
//   GET    /ytdlp/cookies/status → CookieStatus
//   POST   /ytdlp/cookies        { cookies: string } → { ok, status } | 422 { error }
//   DELETE /ytdlp/cookies        → { ok, status }
// Cookie contents are never echoed back by the server.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Cookie, Trash2, Upload } from 'lucide-react';

interface CookieStatus {
  configured: boolean;
  source: 'env' | 'uploaded' | null;
  youtubeCookieCount: number;
  updatedAt: number | null;
  likelyExpired: boolean;
  likelyExpiredAt: number | null;
}

export default function CookiePanel({ api }: { api: string }) {
  const [status, setStatus] = useState<CookieStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const autoOpened = useRef(false);

  const refresh = async () => {
    try {
      const res = await fetch(`${api}/ytdlp/cookies/status`, { credentials: 'include' });
      if (res.ok) setStatus(await res.json());
    } catch { /* status chip just stays generic */ }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Draw attention when YouTube flagged the current cookies as stale.
  useEffect(() => {
    if (status?.likelyExpired && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [status]);

  const save = async () => {
    const text = pasted.trim();
    if (!text || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${api}/ytdlp/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cookies: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: 'err', text: data.error || 'That file does not look like a cookies.txt export — try exporting again.' });
      } else {
        setStatus(data.status ?? null);
        setPasted('');
        setFileName(null);
        if (fileRef.current) fileRef.current.value = '';
        setMsg({ kind: 'ok', text: `Connected — ${data.youtubeCookieCount} YouTube cookies saved. New clips will use them right away.` });
      }
    } catch {
      setMsg({ kind: 'err', text: 'Could not reach the server — check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${api}/ytdlp/cookies`, { method: 'DELETE', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      setStatus(data.status ?? null);
      setMsg({ kind: 'ok', text: 'Cookies removed.' });
    } catch {
      setMsg({ kind: 'err', text: 'Could not reach the server — try again.' });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    setPasted(await f.text());
    setMsg(null);
  };

  const chip = !status?.configured ? (
    <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/40">Not connected</span>
  ) : status.likelyExpired ? (
    <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-400/10 border border-amber-400/30 text-amber-300">Needs refresh</span>
  ) : (
    <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-[#D1FE17]">
      Active · {status.youtubeCookieCount} cookies
    </span>
  );

  return (
    <section className="px-4 pb-10">
      <div className="max-w-3xl mx-auto bg-[#161616] border border-white/10 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center gap-3 px-4 sm:px-5 py-3.5 text-left hover:bg-white/[0.03] transition-colors"
          aria-expanded={open}
        >
          <span className="w-8 h-8 rounded-lg bg-[#D1FE17]/10 border border-[#D1FE17]/25 flex items-center justify-center shrink-0">
            <Cookie className="w-4 h-4 text-[#D1FE17]" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-bold">YouTube cookies</span>
            <span className="block text-xs text-white/40 truncate">Fixes missing subtitles and “confirm you're not a bot” errors</span>
          </span>
          {chip}
          <ChevronDown className={`w-4 h-4 text-white/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="px-4 sm:px-5 pb-5 pt-1 border-t border-white/5">
            {status?.likelyExpired && (
              <p className="mb-3 text-xs text-amber-300/90 bg-amber-400/5 border border-amber-400/20 rounded-lg px-3 py-2">
                YouTube recently rejected these cookies — export a fresh cookies.txt from your browser and upload it again.
              </p>
            )}
            <ol className="text-xs text-white/50 space-y-1.5 mb-4 list-decimal list-inside">
              <li>Install the <span className="text-white/80 font-semibold">“Get cookies.txt LOCALLY”</span> extension in Chrome.</li>
              <li>Open <span className="text-white/80 font-semibold">youtube.com</span> while signed in, click the extension, and export the cookies.txt file.</li>
              <li>Upload (or paste) it below. It stays on the server and is only used to talk to YouTube.</li>
            </ol>

            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                className="hidden"
                onChange={e => onFile(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 text-xs font-bold px-3.5 py-2 rounded-lg bg-white/5 border border-white/10 hover:border-[#D1FE17]/40 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                {fileName ? fileName : 'Choose cookies.txt'}
              </button>
              {status?.configured && status.source === 'uploaded' && (
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg text-red-400/80 hover:text-red-300 hover:bg-red-400/5 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </button>
              )}
            </div>

            <textarea
              value={pasted}
              onChange={e => { setPasted(e.target.value); setMsg(null); }}
              placeholder="…or paste the contents of cookies.txt here"
              rows={3}
              spellCheck={false}
              className="w-full bg-[#0d0d0d] border border-white/10 rounded-xl px-3 py-2.5 text-xs font-mono text-white/70 placeholder:text-white/25 focus:outline-none focus:border-[#D1FE17]/50 resize-y"
            />

            <div className="flex items-center gap-3 mt-3">
              <button
                type="button"
                onClick={save}
                disabled={busy || !pasted.trim()}
                className="text-xs font-black px-4 py-2.5 rounded-lg bg-[#D1FE17] text-black hover:brightness-110 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy ? 'Saving…' : 'Save cookies'}
              </button>
              {msg && (
                <p className={`text-xs font-semibold ${msg.kind === 'ok' ? 'text-[#D1FE17]' : 'text-red-400'}`}>{msg.text}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
