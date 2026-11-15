# SongSeam

Album-colour edge lighting, word-by-word lyrics and a mood DJ for Spotify — built for Windows.

**Live web app:** https://afterglow-three-kappa.vercel.app

- **Screen glow** – a bright gradient band around the whole display in the colours of the current album art. It spins, swells with the bass and flashes on beats, driven by the sound your PC is actually playing (WASAPI loopback, never the microphone).
- **Lyrics on screen** – word-by-word synced lyrics over everything (click-through), or full-screen in **Stage** mode with a blurred album backdrop. The default **Kinetic** style builds each line as moving typography: words fly in as they're sung, in staggered rows of mixed sizes with a big hero word, a highlight box that wipes in and emoji accents (💬 for "tell", 🔥 for "fire" …). Sweep, Word pop and Line styles are still there.
- **Mood DJ** – picks a mood, builds a set from your Liked Songs and playlists, orders it by energy arc, tempo and harmonic key (Camelot wheel), and finds cue points from each song's vocals (cuts long outros, skips long intros on upbeat sets). While playing, the engine listens to each song and mixes out on the beat when it hears the outro start. **Save to Spotify** writes the set as a playlist so Spotify's own *Mix* can do overlapping, EQ'd DJ transitions.

No Spotify login is needed for the glow and lyrics: the desktop app reads the Spotify app through Windows media controls. The DJ needs a Spotify login (see below).

## Run it

```bash
npm install
npm run desktop        # Windows app (needs Rust + MSVC build tools)
npm run dev            # web app at http://localhost:5173
```

### Web app

The same app runs in any browser (lyrics, full-screen Stage, Mood DJ, Save to Spotify):

```bash
npm run build:web      # static site in dist/
```

Deploy `dist/` to any static host. `vercel.json` is included (SPA rewrite so Spotify's `/callback` redirect works). Add `https://<your-domain>/callback` as a Redirect URI in your Spotify app.

In a browser the glow stays inside the page and can't react to Spotify's sound (browsers can't hear other apps), and DJ fades use Spotify's volume control, which is coarser. The Windows app has the full-screen glow, system-audio reactivity and smooth fades.

### Windows installer

```bash
npm run desktop:build  # → src-tauri/target/release/bundle/{nsis,msi}
```

Closing the window keeps SongSeam in the system tray (glow toggle, stage mode, quit).

### On your phone

SongSeam installs as an app from the browser (no app store):

- **Android (Chrome):** open the live web app and tap **⤓ Install app** (or ⋮ → *Install app*).
- **iPhone / iPad (Safari):** tap **Share → Add to Home Screen**. The app's **⤓ Install app** button shows these steps.

It opens full screen from its own icon and keeps the screen awake in Stage. Phones don't let apps listen to Spotify's audio or draw over other apps, so on a phone the glow lives inside SongSeam and follows the album colours rather than the beat.

### Stage, Blackout and TVs

**Stage** is full-screen: big album art and lyrics. **Blackout** (OK / Enter / B, or the Lyrics tab) turns everything black except the edge glow and the lyrics.

On a smart TV (Samsung, LG, Android/Google TV, Fire TV …) open the web app in the TV browser. It starts in Stage with a bigger layout, keeps the screen awake, and works with the remote: **OK** blackout · **◀ ▶** previous/next · **▲ ▼** text size · **Back** to the menu. Add `?tv` to the URL to force TV mode in any browser.



## Mood DJ setup

Spotify requires each user of a development app to bring their own app:

1. Create an app at <https://developer.spotify.com/dashboard> (tick *Web API*).
2. Add the redirect URI shown in the DJ tab — `http://127.0.0.1:43821/callback` for the desktop app, or `<site origin>/callback` for the web build.
3. Put your Client ID in `.env` (`VITE_SPOTIFY_CLIENT_ID`) so it is built in, or paste it into the DJ tab once (it is remembered). Then press **Connect**.

Limits set by Spotify (2026): the app owner needs Premium, controlling playback needs Premium, and dev-mode apps can only read tracks of playlists you own or collaborate on (plus Liked Songs).

## How the DJ stays within Spotify's rules

Spotify's developer policy forbids mixing or overlapping Spotify audio. SongSeam never does: each transition fades the outgoing track down (Windows per-app volume when Spotify plays on this PC, Spotify's volume API otherwise), moves to the next track, and fades it up. Tempo, key and energy come from [ReccoBeats](https://reccobeats.com) because Spotify no longer serves audio features to new apps.

## Layout

| Path | What |
| --- | --- |
| `src-tauri/src/media.rs` | Now playing + transport via Windows media controls |
| `src-tauri/src/audio.rs` | System-audio loopback → bass/mid/treble/beat events |
| `src-tauri/src/volume.rs` | Per-app volume and fades (Windows mixer) |
| `src-tauri/src/shell.rs` | Overlay window, tray, Spotify login loopback listener |
| `src/components/EdgeGlow.tsx` | Rim lighting |
| `src/components/Lyrics.tsx` | Word-by-word lyrics (overlay / stage / preview) |
| `src/dj/planner.ts` | Mood scoring, set ordering, transition planning (unit-tested) |
| `src/dj/runner.ts` | Plays a set and performs the fades |
| `src/services/spotify.ts` | PKCE login + Web API (2026 endpoints) |

## Checks

```bash
npm run verify   # typecheck, planner tests, Rust tests, production build
```

Lyrics come from [LRCLIB](https://lrclib.net).

## License

MIT
