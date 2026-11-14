import { useEffect, useMemo, useRef, useState } from 'react';
import * as Spotify from '../services/spotify';
import { getAudioFeatures } from '../services/audioFeatures';
import { MOODS, planSet, withCues, camelotLabel, keyName, transitionLabel, type DjTrack, type Mood, type SetPlan, type VocalSpan } from '../dj/planner';
import { fetchLyricsFromLrclib } from '../services/lrclib';
import { SetRunner, type NowInfo, type RunnerStatus } from '../dj/runner';
import type { ColorPalette } from '../types';
import { isDesktop, openExternal } from '../services/platform';

interface Props {
  palette: ColorPalette;
  getNow: () => NowInfo | null;
}

const LIKED = '__liked__';

// Kept outside the component so a running set survives switching tabs.
let savedPlan: SetPlan | null = null;
let savedPool: DjTrack[] = [];
const vocalCache = new Map<string, VocalSpan | null>();

/** Where the vocals start and end, from synced lyrics (null if unknown). */
async function vocalSpans(tracks: DjTrack[], onProgress: (done: number) => void): Promise<Map<string, VocalSpan | null>> {
  let done = 0;
  const queue = tracks.filter((t) => !vocalCache.has(t.id));
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const l = await fetchLyricsFromLrclib(t.name, t.artist.split(',')[0], t.durationMs).catch(() => null);
      const lines = l && l.sync !== 'none' ? l.lines : [];
      const last = lines[lines.length - 1];
      vocalCache.set(t.id, lines.length >= 4 ? { firstMs: lines[0].start_ms, lastMs: last.end_ms ?? last.start_ms + 3000 } : null);
      onProgress(++done);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return new Map(tracks.map((t) => [t.id, vocalCache.get(t.id) ?? null]));
}
const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function DjPanel({ palette, getNow }: Props) {
  const [loggedIn, setLoggedIn] = useState(Spotify.isLoggedIn());
  const [clientId, setClientIdState] = useState(Spotify.getClientId());
  const [authBusy, setAuthBusy] = useState(false);
  const [playlists, setPlaylists] = useState<Spotify.PlaylistSummary[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set([LIKED]));
  const [mood, setMood] = useState<Mood>('party');
  const [length, setLength] = useState(15);
  const [progress, setProgress] = useState<string | null>(null);
  const [plan, setPlanState] = useState<SetPlan | null>(savedPlan);
  const setPlan = (p: SetPlan | null) => {
    savedPlan = p;
    setPlanState(p);
  };
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<RunnerStatus>({ state: 'idle', index: 0, message: '', nextFadeInMs: null });
  const pool = useRef<DjTrack[]>(savedPool);
  const getNowRef = useRef(getNow);
  getNowRef.current = getNow;
  const runner = useMemo(() => new SetRunner(() => getNowRef.current(), setStatus), []);

  // Desktop: the set keeps playing when this tab closes. Browser: it stops.
  useEffect(() => () => runner.dispose(), [runner]);

  useEffect(() => {
    if (!loggedIn) return;
    Spotify.getReadablePlaylists()
      .then(setPlaylists)
      .catch((e) => setError(e.message));
  }, [loggedIn]);

  const connect = async () => {
    setError(null);
    Spotify.setClientId(clientId);
    setAuthBusy(true);
    try {
      await Spotify.login();
      setLoggedIn(Spotify.isLoggedIn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthBusy(false);
    }
  };

  const buildPool = async (): Promise<DjTrack[]> => {
    const lib = new Map<string, Spotify.LibraryTrack>();
    if (chosen.has(LIKED)) {
      setProgress('Reading Liked Songs…');
      for (const t of await Spotify.getLikedTracks(500)) lib.set(t.id, t);
    }
    for (const p of playlists ?? []) {
      if (!chosen.has(p.id)) continue;
      setProgress(`Reading “${p.name}”…`);
      for (const t of await Spotify.getPlaylistTracks(p.id, 400)) lib.set(t.id, t);
    }
    const tracks = [...lib.values()];
    if (!tracks.length) throw new Error('No tracks found in the chosen sources.');
    const feats = await getAudioFeatures(
      tracks.map((t) => t.id),
      (done, total) => setProgress(`Analysing tempo, key and energy… ${done}/${total}`),
    );
    const out: DjTrack[] = [];
    for (const t of tracks) {
      const f = feats.get(t.id);
      if (f) out.push({ ...t, ...f });
    }
    if (out.length < 3) throw new Error('Could not get audio analysis for enough of these tracks. Try more or different playlists.');
    return out;
  };

  const makePlan = async () => {
    setError(null);
    setPlan(null);
    try {
      pool.current = await buildPool();
      savedPool = pool.current;
      await planWithCues(planSet(pool.current, mood, length));
      setProgress(`${pool.current.length} tracks analysed`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  };

  const saveToSpotify = async (p: SetPlan) => {
    setError(null);
    setSaving(true);
    try {
      const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const url = await Spotify.savePlaylist(
        `Afterglow · ${MOODS[p.mood].label} set · ${date}`,
        `${p.tracks.length} tracks ordered by energy, tempo and key by Afterglow. Tap Mix → Auto in Spotify for DJ transitions.`,
        p.tracks.map((t) => t.uri),
      );
      setSaved({ url });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** Finds intro/outro cue points from each track's vocals, then shows the plan. */
  const planWithCues = async (p: SetPlan) => {
    setPlan(p);
    const spans = await vocalSpans(p.tracks, (n) => setProgress(`Finding cue points (intros/outros)… ${n}/${p.tracks.length}`));
    if (savedPlan === p) setPlan(withCues(p, spans));
    setProgress(null);
  };

  // Re-plan from the cached pool when mood/length change (not while a set plays).
  useEffect(() => {
    if (pool.current.length && (status.state === 'idle' || status.state === 'done' || status.state === 'error')) void planWithCues(planSet(pool.current, mood, length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, length]);

  if (!loggedIn) {
    return (
      <div className="card space-y-4">
        <div>
          <h3 className="h3">Connect Spotify</h3>
          <p className="muted mt-1">
            The DJ reads your Liked Songs and your own playlists, then plays the planned set on Spotify. Spotify requires your
            own (free) developer app for this:
          </p>
        </div>
        <ol className="steps">
          <li>
            Open <button className="link" onClick={() => void openExternal('https://developer.spotify.com/dashboard')}>developer.spotify.com/dashboard</button> and
            create an app (tick <em>Web API</em>).
          </li>
          <li>
            Add this Redirect URI: <code className="code">{Spotify.redirectUri()}</code>
          </li>
          <li>Copy the app’s Client ID here:</li>
        </ol>
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="Client ID" value={clientId} onChange={(e) => setClientIdState(e.target.value)} spellCheck={false} />
          <button className="btn btn-primary" disabled={!clientId.trim() || authBusy} onClick={connect}>
            {authBusy ? 'Waiting for browser…' : 'Connect'}
          </button>
        </div>
        <p className="muted text-xs">
          Spotify only lets development apps run when the app owner has Premium, and controlling playback needs Premium too.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const running = status.state !== 'idle' && status.state !== 'done' && status.state !== 'error';
  const maxEnergy = 1;

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="h3">1 · Music to pick from</h3>
          <button
            className="btn-ghost text-xs"
            onClick={() => {
              Spotify.logout();
              setLoggedIn(false);
              setPlan(null);
            }}
          >
            Disconnect
          </button>
        </div>
        <div className="chips">
          {[{ id: LIKED, name: 'Liked Songs', total: 0 }, ...(playlists ?? [])].map((p) => (
            <button
              key={p.id}
              className={`chip ${chosen.has(p.id) ? 'chip-on' : ''}`}
              onClick={() =>
                setChosen((s) => {
                  const n = new Set(s);
                  if (n.has(p.id)) n.delete(p.id);
                  else n.add(p.id);
                  return n;
                })
              }
            >
              {p.name}
              {p.total ? <span className="opacity-50"> · {p.total}</span> : null}
            </button>
          ))}
          {playlists === null && <span className="muted">Loading playlists…</span>}
        </div>
        <p className="muted text-xs">Spotify only shares tracks of playlists you own or collaborate on.</p>
      </div>

      <div className="card space-y-3">
        <h3 className="h3">2 · Mood</h3>
        <div className="mood-grid">
          {(Object.keys(MOODS) as Mood[]).map((m) => (
            <button key={m} className={`mood ${mood === m ? 'mood-on' : ''}`} onClick={() => setMood(m)}>
              <span className="font-semibold">{MOODS[m].label}</span>
              <span className="muted text-xs">{MOODS[m].blurb}</span>
            </button>
          ))}
        </div>
        <label className="row">
          <span>Set length</span>
          <input type="range" min={6} max={40} value={length} onChange={(e) => setLength(Number(e.target.value))} />
          <span className="val">{length} tracks</span>
        </label>
        <button className="btn btn-primary w-full" disabled={!chosen.size || running} onClick={makePlan}>
          {plan ? 'Re-read library & plan again' : 'Analyse & plan my set'}
        </button>
        {progress && <p className="muted text-xs">{progress}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {plan && plan.tracks.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="h3">3 · Your {MOODS[plan.mood].label.toLowerCase()} set</h3>
              <p className="muted text-xs">
                {plan.tracks.length} tracks · {fmt(plan.totalMs)}
                {plan.skipped > 0 && ` · ${plan.skipped} didn't fit the mood`}
              </p>
            </div>
            <div className="flex gap-2">
              {Spotify.canSavePlaylists() ? (
                <button className="btn" disabled={saving} onClick={() => saveToSpotify(plan)} title="Save as a Spotify playlist, then use Spotify's Mix for DJ transitions">
                  {saving ? 'Saving…' : 'Save to Spotify'}
                </button>
              ) : (
                <button className="btn" onClick={connect} title="Your login predates playlist saving; reconnect once to allow it">
                  Reconnect to save
                </button>
              )}
              {running ? (
                <button className="btn" onClick={() => runner.stop()}>
                  Stop DJ
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => runner.start(plan)}>
                  ▶ Play set
                </button>
              )}
            </div>
          </div>

          {saved && (
            <div className="dj-status">
              <b>Saved to your Spotify library.</b>
              <span className="block muted text-xs mt-0.5">
                For full DJ mixing (overlaps, EQ, echo, filters, beat-matched blends): open it in Spotify, tap <b>Mix</b>, then <b>Auto</b>. Mix is a Premium beta, rolling out on Spotify's phone apps first.
              </span>
              <button className="link text-xs mt-1" onClick={() => void openExternal(saved.url)}>
                Open the playlist in Spotify
              </button>
            </div>
          )}

          {status.state !== 'idle' && (
            <div className={`dj-status dj-${status.state}`}>
              <b>{status.state === 'transitioning' ? 'Transitioning' : status.state === 'starting' ? 'Starting' : status.state === 'done' ? 'Done' : status.state === 'error' ? 'Problem' : status.state === 'off-plan' ? 'On hold' : `Track ${status.index + 1}/${plan.tracks.length}`}</b>
              {status.nextFadeInMs !== null && status.state === 'playing' && <span> · next fade in {fmt(status.nextFadeInMs)}</span>}
              {status.message && <span className="block muted text-xs mt-0.5">{status.message}</span>}
              {status.fadesAvailable === false && running && (
                <span className="block text-xs mt-0.5" style={{ color: '#f5c542' }}>
                  Spotify isn't playing through this PC's speakers, so the DJ can skip on time but can't fade. Play on this PC for full transitions.
                </span>
              )}
            </div>
          )}

          <EnergyCurve plan={plan} color={palette.primary} active={running ? status.index : -1} />

          <ol className="setlist">
            {plan.tracks.map((t, i) => (
              <li key={t.id}>
                <div className={`set-track ${running && status.index === i ? 'set-track-now' : ''}`}>
                  <span className="set-num">{i + 1}</span>
                  {t.image ? <img src={t.image} alt="" className="set-art" /> : <span className="set-art" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{t.name}</span>
                    <span className="block truncate muted text-xs">{t.artist}</span>
                  </span>
                  <span className="set-meta" title={`${keyName(t.key, t.mode)} · energy ${Math.round(t.energy * 100)}%`}>
                    <span>{Math.round(t.tempo)} BPM</span>
                    <span>{camelotLabel(t.key, t.mode)}</span>
                    <span className="energy" style={{ '--e': t.energy / maxEnergy } as React.CSSProperties} />
                  </span>
                </div>
                {plan.transitions[i] && (
                  <div className={`set-trans trans-${plan.transitions[i].style}`} title={plan.transitions[i].reason}>
                    <span className="trans-tag">{transitionLabel(plan.transitions[i].style)}</span>
                    <span className="muted truncate">{plan.transitions[i].reason}</span>
                    <span className="trans-time">
                      fade {(plan.transitions[i].fadeOutMs / 1000).toFixed(1)}s at {fmt(plan.transitions[i].exitAtMs)}
                      {(plan.cues?.[i + 1]?.cueInMs ?? 0) > 0 && ` → next in at ${fmt(plan.cues![i + 1].cueInMs)}`}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <p className="muted text-xs">
            Tempo/key/energy data: ReccoBeats. Transitions fade one track out and the next in{isDesktop ? ' using the Windows volume mixer' : ''} — songs are never layered.
            Keep Spotify’s own Crossfade off for the cleanest result.
          </p>
        </div>
      )}
    </div>
  );
}

function EnergyCurve({ plan, color, active }: { plan: SetPlan; color: string; active: number }) {
  const w = 600;
  const h = 70;
  const n = plan.tracks.length;
  const x = (i: number) => (n <= 1 ? w / 2 : (i / (n - 1)) * (w - 20) + 10);
  const y = (e: number) => h - 8 - e * (h - 16);
  const actual = plan.tracks.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t.energy).toFixed(1)}`).join(' ');
  const target = plan.targetEnergy.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[70px]" role="img" aria-label="Energy across the set">
      <path d={target} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeDasharray="4 5" strokeWidth="2" />
      <path d={actual} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      {plan.tracks.map((t, i) => (
        <circle key={t.id} cx={x(i)} cy={y(t.energy)} r={i === active ? 6 : 3.5} fill={i === active ? '#fff' : color} />
      ))}
    </svg>
  );
}
