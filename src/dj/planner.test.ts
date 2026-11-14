import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelot, camelotLabel, keyDistance, tempoDistance, moodFit, planSet, planTransition, type DjTrack } from './planner.ts';

let n = 0;
function track(p: Partial<DjTrack>): DjTrack {
  n++;
  return {
    id: p.id ?? `t${String(n).padStart(3, '0')}`,
    uri: `spotify:track:${p.id ?? n}`,
    name: p.name ?? `Song ${n}`,
    artist: p.artist ?? `Artist ${n}`,
    durationMs: 200_000,
    tempo: 120,
    key: 0,
    mode: 1,
    energy: 0.5,
    valence: 0.5,
    danceability: 0.6,
    acousticness: 0.2,
    instrumentalness: 0,
    ...p,
  };
}

test('camelot codes match the standard wheel', () => {
  assert.equal(camelotLabel(0, 1), '8B'); // C major
  assert.equal(camelotLabel(9, 0), '8A'); // A minor
  assert.equal(camelotLabel(7, 1), '9B'); // G major
  assert.equal(camelotLabel(4, 0), '9A'); // E minor
  assert.equal(camelotLabel(11, 1), '1B'); // B major
  assert.equal(camelotLabel(0, 0), '5A'); // C minor
  assert.equal(camelot(-1, 1), null);
});

test('key distance: same, relative, neighbour, clash', () => {
  const c = track({ key: 0, mode: 1 });
  assert.equal(keyDistance(c, track({ key: 0, mode: 1 })), 0);
  assert.equal(keyDistance(c, track({ key: 9, mode: 0 })), 1); // relative minor
  assert.equal(keyDistance(c, track({ key: 7, mode: 1 })), 1); // fifth
  assert.ok(keyDistance(c, track({ key: 6, mode: 1 })) >= 3); // tritone
});

test('tempo distance treats double time as the same groove', () => {
  assert.ok(tempoDistance(85, 170) < 0.01);
  assert.ok(tempoDistance(120, 124) < 0.04);
  assert.ok(tempoDistance(100, 130) > 0.2);
});

test('mood fit prefers matching tracks', () => {
  const banger = track({ energy: 0.92, valence: 0.7, tempo: 126, danceability: 0.85 });
  const ballad = track({ energy: 0.25, valence: 0.2, tempo: 72, acousticness: 0.8 });
  assert.ok(moodFit(banger, 'party') < moodFit(ballad, 'party'));
  assert.ok(moodFit(ballad, 'heartbreak') < moodFit(banger, 'heartbreak'));
});

test('transition styles follow key, tempo and energy', () => {
  const a = track({ key: 0, mode: 1, tempo: 124, energy: 0.7 });
  assert.equal(planTransition(a, track({ key: 7, mode: 1, tempo: 125, energy: 0.72 })).style, 'blend');
  assert.equal(planTransition(a, track({ key: 3, mode: 1, tempo: 140, energy: 0.9 })).style, 'lift');
  assert.equal(planTransition(a, track({ key: 3, mode: 1, tempo: 100, energy: 0.4 })).style, 'wind-down');
  assert.equal(planTransition(a, track({ key: 6, mode: 1, tempo: 150, energy: 0.68 })).style, 'reset');
  const t = planTransition(a, track({ key: 7, mode: 1, tempo: 125, energy: 0.72 }));
  assert.equal(t.exitAtMs + t.fadeOutMs, a.durationMs, 'fade ends exactly at the end of the track');
});

function library(): DjTrack[] {
  const out: DjTrack[] = [];
  for (let i = 0; i < 60; i++) {
    out.push(
      track({
        id: `lib${String(i).padStart(2, '0')}`,
        artist: `Artist ${i % 12}`,
        energy: (i % 20) / 20 + 0.02,
        valence: ((i * 7) % 20) / 20,
        tempo: 70 + ((i * 13) % 90),
        key: (i * 5) % 12,
        mode: i % 2,
        danceability: ((i * 3) % 10) / 10,
      }),
    );
  }
  return out;
}

test('planSet returns the requested length with no duplicates', () => {
  const plan = planSet(library(), 'party', 12);
  assert.equal(plan.tracks.length, 12);
  assert.equal(new Set(plan.tracks.map((t) => t.id)).size, 12);
  assert.equal(plan.transitions.length, 11);
  assert.ok(plan.totalMs > 0);
});

test('planSet is deterministic', () => {
  const a = planSet(library(), 'chill', 10).tracks.map((t) => t.id);
  const b = planSet(library().reverse(), 'chill', 10).tracks.map((t) => t.id);
  assert.deepEqual(a, b);
});

test('party sets carry more energy than chill sets', () => {
  const avg = (ts: DjTrack[]) => ts.reduce((s, t) => s + t.energy, 0) / ts.length;
  assert.ok(avg(planSet(library(), 'party', 10).tracks) > avg(planSet(library(), 'chill', 10).tracks) + 0.2);
});

test('a small library still produces a set', () => {
  const plan = planSet(library().slice(0, 4), 'workout', 10);
  assert.equal(plan.tracks.length, 4);
  assert.equal(planSet([], 'focus', 10).tracks.length, 0);
});

test('neighbouring tracks are mostly harmonically compatible', () => {
  const plan = planSet(library(), 'happy', 12);
  const clashes = plan.tracks.slice(1).filter((t, i) => keyDistance(plan.tracks[i], t) >= 4).length;
  assert.ok(clashes <= 3, `too many key clashes: ${clashes}`);
});

import { cuesFor, withCues } from './planner.ts';

test('long outros are cut two bars after the last vocal', () => {
  const t = track({ tempo: 120, durationMs: 240_000 }); // bar = 2 s
  const { cue, exitAtMs } = cuesFor(t, { firstMs: 10_000, lastMs: 180_000 }, 'party', 3000, false);
  assert.equal(exitAtMs, 184_000);
  assert.ok(cue.outroCutMs > 50_000);
});

test('short outros and calm moods keep the ending', () => {
  const t = track({ tempo: 120, durationMs: 200_000 });
  assert.equal(cuesFor(t, { firstMs: 5000, lastMs: 190_000 }, 'party', 4000, false).exitAtMs, 196_000);
  assert.equal(cuesFor(t, { firstMs: 5000, lastMs: 180_000 }, 'chill', 4000, false).exitAtMs, 196_000);
});

test('long intros are skipped on energetic sets, never for the opener', () => {
  const t = track({ tempo: 120, durationMs: 240_000 });
  const v = { firstMs: 40_000, lastMs: 230_000 };
  assert.equal(cuesFor(t, v, 'workout', 3000, false).cue.cueInMs, 32_000);
  assert.equal(cuesFor(t, v, 'workout', 3000, true).cue.cueInMs, 0);
  assert.equal(cuesFor(t, v, 'chill', 3000, false).cue.cueInMs, 0);
});

test('no lyrics → play the whole track', () => {
  const t = track({ durationMs: 200_000 });
  const r = cuesFor(t, null, 'party', 5000, false);
  assert.deepEqual(r.cue, { cueInMs: 0, introCutMs: 0, outroCutMs: 0 });
  assert.equal(r.exitAtMs, 195_000);
});

test('withCues shortens the set and keeps fades inside each track', () => {
  const plan = planSet(library(), 'party', 8);
  const vocals = new Map(plan.tracks.map((t) => [t.id, { firstMs: 30_000, lastMs: 120_000 }]));
  const cued = withCues(plan, vocals);
  assert.equal(cued.cues!.length, 8);
  assert.ok(cued.totalMs < plan.totalMs);
  cued.transitions.forEach((tr, i) => assert.ok(tr.exitAtMs + tr.fadeOutMs <= cued.tracks[i].durationMs));
});
