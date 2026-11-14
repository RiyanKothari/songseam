import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateWordTimings, parseLrcWithInterpolation, syllables } from './lyricParser.ts';

test('syllable counts are roughly right', () => {
  assert.equal(syllables('love'), 1);
  assert.equal(syllables('younger'), 2);
  assert.equal(syllables('nothing'), 2);
  assert.equal(syllables('attention'), 3);
  assert.equal(syllables("thinkin'"), 2);
  assert.ok(syllables('नमस्ते') >= 2, 'non-Latin words still get weight');
});

test('a line is sung at the song pace, not stretched over the pause', () => {
  // Three continuous lines at ~300ms/syllable, then a 10s pause after a short line.
  const lines = estimateWordTimings([
    { start_ms: 0, text: 'one two three four five six' }, // 6 syl, gap 1800
    { start_ms: 1800, text: 'seven eight nine ten eleven' }, // ~8 syl
    { start_ms: 4200, text: 'and the night goes on forever' }, // 8 syl
    { start_ms: 6600, text: 'hold on' }, // 2 syl, then 10 s gap
    { start_ms: 16600, text: 'again we go' },
  ]);
  const held = lines[3];
  const sweep = held.words!.at(-1)!.end_ms! - held.start_ms;
  assert.ok(sweep < 1500, `short line before a pause should finish quickly, took ${sweep}ms`);
  for (const l of lines) {
    const ws = l.words!;
    for (let i = 1; i < ws.length; i++) assert.ok(ws[i].start_ms >= ws[i - 1].start_ms, 'words in order');
    const next = lines[lines.indexOf(l) + 1];
    if (next) assert.ok(ws.at(-1)!.end_ms! <= next.start_ms, 'a line never runs into the next one');
  }
});

test('LRC parsing keeps line starts exact', () => {
  const lines = parseLrcWithInterpolation('[00:01.50] Hello there\n[00:04.20] General Kenobi\n[01:02.003] Late line');
  assert.deepEqual(
    lines.map((l) => l.start_ms),
    [1500, 4200, 62003],
  );
  assert.equal(lines[0].words![0].start_ms, 1500);
});
