import type { LyricLine, LyricWord } from '../types';

/**
 * Parses LRCLIB's YAML-like `lyricsfile` string containing per-word timestamps.
 */
export function parseWordSyncYaml(yamlContent: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const rawLines = yamlContent.split('\n');

  let currentLine: Partial<LyricLine> | null = null;
  let currentWords: LyricWord[] = [];
  let currentWord: Partial<LyricWord> | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    // Start of line item: "- text: ..."
    if (trimmed.startsWith('- text:')) {
      if (currentLine && currentLine.text) {
        if (currentWord && currentWord.text && currentWord.start_ms !== undefined) {
          currentWords.push({
            text: currentWord.text,
            start_ms: currentWord.start_ms,
            end_ms: currentWord.end_ms,
          });
          currentWord = null;
        }
        // Calculate missing word end_ms
        finalizeWordTimings(currentWords, currentLine.end_ms);
        currentLine.words = currentWords;
        lines.push(currentLine as LyricLine);
      }

      const match = trimmed.match(/- text:\s*(.*)$/);
      let text = match ? match[1] : '';
      if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
      if (text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1);
      text = text.replace(/\\"/g, '"').replace(/''/g, "'");

      currentLine = { text: text.trim(), words: [] };
      currentWords = [];
      currentWord = null;
      continue;
    }

    if (currentLine) {
      if (trimmed.startsWith('start_ms:')) {
        const val = parseInt(trimmed.replace('start_ms:', '').trim(), 10);
        if (!currentWord) {
          currentLine.start_ms = isNaN(val) ? 0 : val;
        } else {
          currentWord.start_ms = isNaN(val) ? 0 : val;
        }
      } else if (trimmed.startsWith('end_ms:')) {
        const val = parseInt(trimmed.replace('end_ms:', '').trim(), 10);
        if (!currentWord) {
          currentLine.end_ms = isNaN(val) ? 0 : val;
        } else {
          currentWord.end_ms = isNaN(val) ? 0 : val;
        }
      } else if (raw.includes('  - text:')) {
        // A word within the line
        if (currentWord && currentWord.text && currentWord.start_ms !== undefined) {
          currentWords.push({
            text: currentWord.text,
            start_ms: currentWord.start_ms,
            end_ms: currentWord.end_ms,
          });
        }
        const match = trimmed.match(/- text:\s*(.*)$/);
        let wordText = match ? match[1] : '';
        if (wordText.startsWith('"') && wordText.endsWith('"')) wordText = wordText.slice(1, -1);
        if (wordText.startsWith("'") && wordText.endsWith("'")) wordText = wordText.slice(1, -1);
        wordText = wordText.replace(/\\"/g, '"').replace(/''/g, "'");
        currentWord = { text: wordText };
      }
    }
  }

  // Push final line
  if (currentLine && currentLine.text) {
    if (currentWord && currentWord.text && currentWord.start_ms !== undefined) {
      currentWords.push({
        text: currentWord.text,
        start_ms: currentWord.start_ms,
        end_ms: currentWord.end_ms,
      });
    }
    finalizeWordTimings(currentWords, currentLine.end_ms);
    currentLine.words = currentWords;
    lines.push(currentLine as LyricLine);
  }

  return lines.filter((l) => l.start_ms !== undefined && l.text);
}

/**
 * Ensures every word has an exact start_ms and end_ms
 */
function finalizeWordTimings(words: LyricWord[], lineEndMs?: number): void {
  for (let i = 0; i < words.length; i++) {
    const cur = words[i];
    if (!cur.end_ms) {
      if (i + 1 < words.length && words[i + 1].start_ms !== undefined) {
        cur.end_ms = words[i + 1].start_ms;
      } else if (lineEndMs && lineEndMs > cur.start_ms) {
        cur.end_ms = lineEndMs;
      } else {
        cur.end_ms = cur.start_ms + 600;
      }
    }
  }
}

/**
 * Parses standard .lrc synced lyrics text:
 * [00:12.34] Lyrics line here
 * Supports multiple brackets per line and interpolates word timestamps cleanly.
 */
export function parseLrcWithInterpolation(lrcContent: string): LyricLine[] {
  const rawLines = lrcContent.split(/\r?\n/);
  const parsedLines: { start_ms: number; text: string }[] = [];

  // Match one or more [mm:ss.xx] or [mm:ss:xx] or [mm:ss] tags
  const tagRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{2,3}))?\]/g;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[ar:') || trimmed.startsWith('[ti:') || trimmed.startsWith('[al:')) {
      continue;
    }

    const timestamps: number[] = [];
    let match: RegExpExecArray | null;

    // Collect all timestamps on this line
    while ((match = tagRegex.exec(trimmed)) !== null) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msPart = match[3] || '0';
      const ms = parseInt(msPart.padEnd(3, '0').slice(0, 3), 10);
      const totalMs = minutes * 60 * 1000 + seconds * 1000 + ms;
      timestamps.push(totalMs);
    }

    // Strip timestamps to get the lyric text
    const text = trimmed.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{2,3})?\]/g, '').trim();

    if (text) {
      for (const ts of timestamps) {
        parsedLines.push({ start_ms: ts, text });
      }
    }
  }

  parsedLines.sort((a, b) => a.start_ms - b.start_ms);

  return estimateWordTimings(parsedLines);
}

/** Rough syllable count: vowel groups, ignoring a silent trailing "e". */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  // Non-Latin scripts (e.g. Hindi, Korean): approximate by letter count.
  if (!w) return Math.max(1, Math.round([...word.replace(/[\p{P}\s]/gu, '')].length / 2));
  const groups = w.replace(/(?<=[^aeiouy])e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * Line-synced lyrics only say when each line starts. Estimate when each word
 * is sung: learn the song's singing speed (ms per syllable) from lines that
 * run straight into the next one, then sing every line at that pace instead
 * of stretching it over the pause before the next line.
 */
export function estimateWordTimings(parsed: { start_ms: number; text: string }[]): LyricLine[] {
  const info = parsed.map((cur, i) => {
    const words = cur.text.split(/\s+/).filter(Boolean);
    const syl = words.map(syllables);
    const total = syl.reduce((a, b) => a + b, 0);
    const gap = parsed[i + 1] ? parsed[i + 1].start_ms - cur.start_ms : 0;
    return { words, syl, total, gap };
  });

  // The lower half of gap/syllable ratios ≈ continuous singing (pauses only make it bigger).
  const rates = info.filter((x) => x.gap > 0 && x.total >= 3).map((x) => x.gap / x.total).sort((a, b) => a - b);
  const pace = Math.min(420, Math.max(140, median(rates.slice(0, Math.max(1, Math.ceil(rates.length / 2)))) || 260));

  return parsed.map((cur, i) => {
    const { words, syl, total, gap } = info[i];
    const room = gap > 0 ? gap - 150 : 6000;
    const sung = Math.max(Math.min(room, 450), Math.min(room, total * pace));
    const msPerSyl = sung / Math.max(1, total);
    let t = cur.start_ms;
    const lw: LyricWord[] = words.map((text, k) => {
      const d = syl[k] * msPerSyl;
      const w = { text, start_ms: Math.round(t), end_ms: Math.round(t + d) };
      t += d;
      return w;
    });
    return { text: cur.text, start_ms: cur.start_ms, end_ms: Math.round(cur.start_ms + sung), words: lw };
  });
}

/**
 * Fallback: Maps plain un-synced text lyrics evenly across a track duration
 * so users NEVER get a blank "No lyrics available" screen!
 */
export function parsePlainLyricsWithEstimatedSync(plainText: string, durationMs: number = 200000): LyricLine[] {
  const rawLines = plainText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return [];

  // Leave 8 seconds at beginning for intro, 5 seconds at end for outro
  const startOffset = Math.min(10000, durationMs * 0.05);
  const playableDuration = Math.max(10000, durationMs - startOffset - 6000);
  const timePerLine = Math.floor(playableDuration / rawLines.length);

  return rawLines.map((line, idx) => {
    const lineStart = Math.round(startOffset + idx * timePerLine);
    const lineDuration = Math.max(1500, timePerLine - 200);
    const lineEnd = lineStart + lineDuration;

    const rawWords = line.split(/\s+/).filter(Boolean);
    const totalChars = rawWords.reduce((acc, w) => acc + Math.max(w.length, 1), 0);

    let offset = lineStart;
    const words: LyricWord[] = rawWords.map((word) => {
      const charWeight = Math.max(word.length, 1) / totalChars;
      const wordDur = Math.max(180, Math.floor(lineDuration * charWeight));
      const wStart = offset;
      offset += wordDur;
      return {
        text: word,
        start_ms: wStart,
        end_ms: wStart + wordDur,
      };
    });

    return {
      text: line,
      start_ms: lineStart,
      end_ms: lineEnd,
      words,
    };
  });
}
