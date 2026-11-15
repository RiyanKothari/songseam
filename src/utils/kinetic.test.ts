import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emojiFor, layoutLine, widthOf } from './kinetic.ts';

const split = (s: string) => s.split(' ');

test('every word appears exactly once, in order', () => {
  const words = split("You can tell it to the moon and back tonight, I'm never coming home");
  const l = layoutLine(words);
  const ks = l.rows.flatMap((r) => r.words.map((w) => w.k));
  assert.deepEqual(ks, words.map((_, k) => k));
});

test('same line → same composition (chorus repeats look identical)', () => {
  const a = layoutLine(split('You can tell it'));
  const b = layoutLine(split('You can tell it'));
  assert.deepEqual(a, b);
});

test('one hero word is clearly bigger than filler words', () => {
  const l = layoutLine(split('You can tell it'));
  const all = l.rows.flatMap((r) => r.words);
  const max = Math.max(...all.map((w) => w.size));
  const you = all.find((w) => w.text === 'You')!;
  assert.ok(max >= 1.6);
  assert.ok(you.size < 0.9);
  assert.equal(you.tone, 'dim');
});

test('emoji accent picks a keyword, once per line', () => {
  assert.equal(emojiFor('tell'), '💬');
  assert.equal(emojiFor('Love,'), '❤️');
  assert.equal(emojiFor('table'), undefined);
  const l = layoutLine(split('Tell me you love me'));
  assert.equal(l.rows.flatMap((r) => r.words).filter((w) => w.emoji).length, 1);
  assert.equal(layoutLine(split('Tell me you love me'), { emoji: false }).rows.flatMap((r) => r.words).filter((w) => w.emoji).length, 0);
});

test('long lines are scaled to fit the width and height budget', () => {
  const words = split('Supercalifragilisticexpialidocious even though the sound of it is something quite atrocious if you say it loud enough');
  const l = layoutLine(words);
  assert.ok(l.scale < 1 && l.scale > 0.2);
  for (const r of l.rows) {
    const w = r.words.reduce((s, x) => s + widthOf(x.text, x.size), 0);
    assert.ok(w * l.scale <= 10.01, `row too wide: ${w * l.scale}`);
  }
});

test('empty line has no rows', () => {
  assert.deepEqual(layoutLine([]), { rows: [], scale: 1 });
});
