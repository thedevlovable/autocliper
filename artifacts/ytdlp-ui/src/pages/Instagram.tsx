import { useRef, useState, type FormEvent } from 'react';
import { AppHeader } from '../components/AppHeader';
import { Footer } from '../components/Footer';
import { API } from './ClipperPage';
import {
  Search, Download, Instagram as InstagramIcon, Film, Image as ImageIcon,
  Lock, BadgeCheck, Loader2, Clock3, AlertCircle,
} from 'lucide-react';

// ── Types (mirror api-server/src/routes/instagram.ts) ────────────────────────
interface IgProfile {
  username: string;
  fullName?: string;
  biography?: string;
  followers?: number;
  following?: number;
  totalPosts?: number;
  profilePictureUrl?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
}
interface IgMedia {
  downloadUrl: string;
  mediaType: 'VIDEO' | 'PHOTO' | 'UNKNOWN';
  thumbnailUrl?: string;
  caption?: string;
  id?: string;
}
type MediaKind = 'posts' | 'reels' | 'stories';

const fmt = (n?: number) =>
  n === undefined ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

const viewUrl = (u: string) => `${API}/ig/view?u=${encodeURIComponent(u)}`;
const downloadUrl = (m: IgMedia, name: string) =>
  `${API}/ig/download?u=${encodeURIComponent(m.downloadUrl)}&name=${encodeURIComponent(name)}`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.');
  return body;
}

// ── Media card ────────────────────────────────────────────────────────────────
function MediaCard({ media, filename }: { media: IgMedia; filename: string }) {
  const [imgFailed, setImgFailed] = useState(false);
  const thumb = media.thumbnailUrl || (media.mediaType === 'PHOTO' ? media.downloadUrl : undefined);
  return (
    <div className="group relative rounded-xl overflow-hidden border border-white/10 bg-[#161616] aspect-[4/5]">
      {thumb && !imgFailed ? (
        <img
          src={viewUrl(thumb)}
          alt={media.caption || 'Instagram media'}
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white/25">
          {media.mediaType === 'VIDEO' ? <Film className="w-8 h-8" /> : <ImageIcon className="w-8 h-8" />}
          <span className="text-[11px] font-semibold uppercase tracking-wider">Preview unavailable</span>
        </div>
      )}

      {/* Type badge */}
      <span className="absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/60 backdrop-blur px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white/80">
        {media.mediaType === 'VIDEO' ? <Film className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
        {media.mediaType === 'VIDEO' ? 'Video' : media.mediaType === 'PHOTO' ? 'Photo' : 'Media'}
      </span>

      {/* Bottom overlay */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2.5 pt-8">
        {media.caption && (
          <p className="text-[11px] text-white/70 leading-snug line-clamp-2 mb-2">{media.caption}</p>
        )}
        <a
          href={downloadUrl(media, filename)}
          className="flex items-center justify-center gap-1.5 w-full rounded-lg bg-[#D1FE17] text-black text-xs font-black py-2 hover:bg-[#c5f010] active:scale-[0.98] transition-all"
        >
          <Download className="w-3.5 h-3.5" />
          Download
        </a>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function InstagramPage() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [profile, setProfile] = useState<IgProfile | null>(null);
  const [media, setMedia] = useState<Partial<Record<MediaKind, IgMedia[]>>>({});
  const [tab, setTab] = useState<MediaKind>('posts');
  const [loadingKinds, setLoadingKinds] = useState<Partial<Record<MediaKind, boolean>>>({});

  // Pasted single post/reel link → items shown without a profile
  const [singleItems, setSingleItems] = useState<IgMedia[] | null>(null);

  // Every new search bumps the generation; in-flight responses from an older
  // generation are dropped so a previous account's media can never bleed into
  // the current results.
  const genRef = useRef(0);

  const reset = () => {
    setError(null);
    setProfile(null);
    setMedia({});
    setSingleItems(null);
    setTab('posts');
    setLoadingKinds({});
  };

  const loadKind = async (username: string, kind: MediaKind): Promise<IgMedia[]> => {
    const d = await getJson<{ items: IgMedia[] }>(`/ig/media?username=${encodeURIComponent(username)}&kind=${kind}`);
    return d.items;
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = input.trim();
    if (!q || loading) return;
    const gen = ++genRef.current;
    reset();
    setLoading(true);
    try {
      const isItemLink = /instagram\.com\/(p|reel|reels|tv)\//i.test(q);
      if (isItemLink) {
        const d = await getJson<{ type: string; username?: string; items?: IgMedia[] }>(`/ig/resolve?url=${encodeURIComponent(q)}`);
        if (gen !== genRef.current) return;
        if (d.type === 'media' && d.items) {
          setSingleItems(d.items);
          return;
        }
        if (d.type === 'profile' && d.username) {
          setInput(d.username);
        }
      }
      const p = await getJson<{ profile: IgProfile }>(`/ig/profile?username=${encodeURIComponent(q)}`);
      if (gen !== genRef.current) return;
      setProfile(p.profile);
      if (!p.profile.isPrivate) {
        const posts = await loadKind(p.profile.username, 'posts');
        if (gen !== genRef.current) return;
        setMedia({ posts });
      }
    } catch (err) {
      if (gen === genRef.current) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      }
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  };

  const switchTab = async (kind: MediaKind) => {
    setTab(kind);
    if (!profile || media[kind] || loadingKinds[kind]) return;
    const gen = genRef.current;
    setLoadingKinds((l) => ({ ...l, [kind]: true }));
    setError(null);
    try {
      const items = await loadKind(profile.username, kind);
      if (gen !== genRef.current) return; // a newer search owns the screen now
      setMedia((m) => ({ ...m, [kind]: items }));
    } catch (err) {
      if (gen === genRef.current) {
        setError(err instanceof Error ? err.message : 'Could not load media. Try again.');
      }
    } finally {
      if (gen === genRef.current) setLoadingKinds((l) => ({ ...l, [kind]: false }));
    }
  };

  const items = singleItems ?? media[tab];
  const gridName = profile?.username ?? 'instagram';

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans flex flex-col">
      <AppHeader />

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-10">
        {/* Hero */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 bg-[#D1FE17]/10 border border-[#D1FE17]/20 rounded-full px-4 py-1.5 mb-4">
            <InstagramIcon className="w-4 h-4 text-[#D1FE17]" />
            <span className="text-[#D1FE17] text-xs font-black uppercase tracking-wider">Instagram tools</span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight">
            Instagram profile viewer <span className="text-[#D1FE17]">&amp; downloader</span>
          </h1>
          <p className="text-white/45 mt-3 max-w-xl mx-auto text-sm sm:text-base">
            Check any public profile's stats, then download posts, reels and stories in original quality.
            Works with a username or any Instagram link.
          </p>
        </div>

        {/* Search */}
        <form onSubmit={submit} className="flex gap-2 max-w-2xl mx-auto mb-8">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="@username or instagram.com link"
              autoFocus
              className="w-full bg-[#161616] border border-white/10 focus:border-[#D1FE17]/50 rounded-xl pl-10 pr-4 py-3 text-sm text-white placeholder:text-white/25 outline-none transition-colors"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="flex items-center gap-2 bg-[#D1FE17] disabled:opacity-40 text-black text-sm font-black px-5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            <span className="hidden sm:inline">{loading ? 'Loading…' : 'Look up'}</span>
          </button>
        </form>

        {/* Error */}
        {error && (
          <div className="max-w-2xl mx-auto mb-8 flex items-start gap-3 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Profile card */}
        {profile && (
          <div className="max-w-2xl mx-auto mb-8 bg-[#161616] border border-white/10 rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-4">
              {profile.profilePictureUrl ? (
                <img
                  src={viewUrl(profile.profilePictureUrl)}
                  alt={profile.username}
                  className="w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover border-2 border-[#D1FE17]/40"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-2xl font-black text-[#D1FE17]">
                  {profile.username[0].toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="font-black text-lg truncate">{profile.fullName || profile.username}</p>
                  {profile.isVerified && <BadgeCheck className="w-4 h-4 text-[#D1FE17] shrink-0" />}
                  {profile.isPrivate && (
                    <span className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wider bg-white/10 rounded-full px-2 py-0.5 text-white/60">
                      <Lock className="w-3 h-3" /> Private
                    </span>
                  )}
                </div>
                <p className="text-white/40 text-sm">@{profile.username}</p>
                <div className="flex gap-4 mt-2 text-sm">
                  <span><b className="text-white">{fmt(profile.totalPosts)}</b> <span className="text-white/40">posts</span></span>
                  <span><b className="text-white">{fmt(profile.followers)}</b> <span className="text-white/40">followers</span></span>
                  <span><b className="text-white">{fmt(profile.following)}</b> <span className="text-white/40">following</span></span>
                </div>
              </div>
            </div>
            {profile.biography && (
              <p className="text-white/60 text-sm mt-4 whitespace-pre-line leading-relaxed">{profile.biography}</p>
            )}
          </div>
        )}

        {/* Private account notice */}
        {profile?.isPrivate && (
          <div className="max-w-2xl mx-auto flex items-start gap-3 bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 mb-8">
            <Lock className="w-4 h-4 text-white/40 shrink-0 mt-0.5" />
            <p className="text-sm text-white/50">
              This account is private — media can't be viewed or downloaded. Only public accounts are supported.
            </p>
          </div>
        )}

        {/* Tabs (profile mode, public only) */}
        {profile && !profile.isPrivate && (
          <div className="flex items-center justify-center gap-2 mb-6">
            {(['posts', 'reels', 'stories'] as const).map((k) => (
              <button
                key={k}
                onClick={() => void switchTab(k)}
                className={`px-4 py-2 rounded-full text-sm font-bold capitalize transition-all ${
                  tab === k
                    ? 'bg-[#D1FE17] text-black'
                    : 'bg-white/[0.05] border border-white/10 text-white/50 hover:text-white hover:bg-white/10'
                }`}
              >
                {k}
                {media[k] && <span className="ml-1.5 opacity-60">({media[k]!.length})</span>}
              </button>
            ))}
          </div>
        )}

        {/* Grid */}
        {loadingKinds[tab] && (
          <div className="flex items-center justify-center gap-2 py-16 text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading {tab}…
          </div>
        )}
        {!loadingKinds[tab] && items && items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((m, i) => (
              <MediaCard key={m.id ?? m.downloadUrl} media={m} filename={`${gridName}_${singleItems ? 'media' : tab}_${i + 1}`} />
            ))}
          </div>
        )}
        {!loadingKinds[tab] && items && items.length === 0 && (
          <div className="text-center py-16 text-white/35 text-sm">
            {tab === 'stories' && !singleItems ? 'No active stories in the last 24 hours.' : 'Nothing found here.'}
          </div>
        )}

        {/* Footnote */}
        {(profile || singleItems) && (
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-white/25 mt-8">
            <Clock3 className="w-3 h-3" />
            Results are cached for 30 minutes. Download links come straight from Instagram's servers.
          </p>
        )}

        {/* Empty state helper */}
        {!profile && !singleItems && !loading && !error && (
          <div className="max-w-2xl mx-auto grid sm:grid-cols-3 gap-3 mt-4">
            {[
              { icon: Search, title: 'Look up a profile', desc: 'Type a username like @nasa to see stats, bio and recent posts.' },
              { icon: Film, title: 'Grab reels & stories', desc: 'Switch tabs to browse reels and active 24-hour stories.' },
              { icon: Download, title: 'Download originals', desc: 'Paste a post or reel link to download just that one file.' },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="bg-[#141414] border border-white/[0.07] rounded-xl p-4">
                <Icon className="w-5 h-5 text-[#D1FE17] mb-2" />
                <p className="text-sm font-bold">{title}</p>
                <p className="text-xs text-white/40 mt-1 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
