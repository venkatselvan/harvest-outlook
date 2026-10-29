/** Scoring helpers for the speech qualification harness. Code, not a model, decides pass/fail. */

const TAMIL_DIGITS = "௦௧௨௩௪௫௬௭௮௯";
const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** NFC, lower-case, Indic digits to ASCII, thousands commas removed, punctuation to spaces. */
export function normaliseText(s: string): string {
  let out = s.normalize("NFC").toLowerCase();
  out = [...out]
    .map((ch) => {
      const t = TAMIL_DIGITS.indexOf(ch);
      if (t >= 0) return String(t);
      const d = DEVANAGARI_DIGITS.indexOf(ch);
      return d >= 0 ? String(d) : ch;
    })
    .join("");
  out = out.replace(/(\d),(?=\d{3}\b)/g, "$1");
  // Keep letters, marks (needed for Indic scripts), digits and decimal points between digits.
  out = out.replace(/(?<!\d)\.|\.(?!\d)/g, " ").replace(/[^\p{L}\p{M}\p{N}. ]+/gu, " ");
  return out.replace(/\s+/g, " ").trim();
}

export const tokens = (s: string): string[] => {
  const n = normaliseText(s);
  return n ? n.split(" ") : [];
};

/** Word error rate (edit distance over tokens / reference length). Reference must be non-empty. */
export function wer(reference: string, hypothesis: string): number {
  const r = tokens(reference);
  const h = tokens(hypothesis);
  if (r.length === 0) throw new Error("empty reference");
  const prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (r[i - 1] === h[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[h.length]! / r.length;
}

export interface ExpectItem {
  kind: string;
  normalized: string;
  anyOf: string[];
}
export interface SpeechCase {
  id: string;
  text: string;
  tags: string[];
  expect: ExpectItem[];
}

export interface FieldHit {
  kind: string;
  normalized: string;
  hit: boolean;
}

/** An expected field is a hit when any accepted surface form occurs in the normalised transcript. */
export function checkFields(c: SpeechCase, transcript: string): FieldHit[] {
  const t = ` ${normaliseText(transcript)} `;
  return c.expect.map((x) => ({
    kind: x.kind,
    normalized: x.normalized,
    hit: x.anyOf.some((f) => {
      const n = normaliseText(f);
      if (n.length === 0) return false;
      // ASCII forms must match whole tokens ("15" must not hit "2015"); Indic forms must start at a token boundary but may continue (suffixes)
      // because Tamil/Hindi attach case suffixes to the noun (ஏக்கரில், एकड़ों).
      return /^[\x00-\x7f]+$/.test(n) ? t.includes(` ${n} `) : t.includes(` ${n}`);
    }),
  }));
}

export interface CaseScore {
  id: string;
  wer: number;
  fieldHits: FieldHit[];
  fieldsPassed: boolean;
}

export function scoreCase(c: SpeechCase, transcript: string): CaseScore {
  const fieldHits = checkFields(c, transcript);
  return { id: c.id, wer: wer(c.text, transcript), fieldHits, fieldsPassed: fieldHits.every((f) => f.hit) };
}

export function summarise(scores: CaseScore[]): { n: number; meanWer: number; fieldPassRate: number } {
  const n = scores.length;
  return {
    n,
    meanWer: n ? scores.reduce((s, x) => s + x.wer, 0) / n : 0,
    fieldPassRate: n ? scores.filter((x) => x.fieldsPassed).length / n : 0,
  };
}
