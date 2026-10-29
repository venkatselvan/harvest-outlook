// Shared helpers for the crop-catalogue scripts.
// zod and the contracts are loaded through the contracts package so the scripts
// share one zod instance with the schemas (the repo root has no direct dependency).
export { z } from '../../packages/contracts/node_modules/zod/index.js';
export * from '../../packages/contracts/src/index.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW_DIR = join(ROOT, 'data', 'raw', 'crops');
export const PROFILE_DIR = join(ROOT, 'data', 'curated', 'crops');
export const EVIDENCE_DIR = join(ROOT, 'data', 'curated', 'crop-evidence');
export const MANIFEST_DIR = join(ROOT, 'data', 'manifests');

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Whitespace/NBSP/dash/quote-normalised form used for excerpt-in-source checks. */
export function normaliseForMatch(s: string): string {
  return s
    .replace(/[  ​]/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', ndash: '-', mdash: '-', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', frac12: '1/2', plusmn: '±', times: 'x', sup2: '2', sup3: '3', middot: '·', hellip: '...' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

export function htmlToText(html: string): string {
  let t = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/(p|div|tr|li|h[1-6]|table|br)>|<br\s*\/?>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/[ \t ]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}
