// Fetch each registered catalogue source, store the raw bytes (gitignored) with
// sha256 + fetch time, and extract plain text for the excerpt check.
// Usage: pnpm --filter @harvest/contracts exec tsx ../../scripts/catalogue/fetch.ts [sourceKey ...]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR, htmlToText } from './common.ts';
import { SOURCES } from './sources.ts';

const UA = 'Mozilla/5.0 (compatible; HarvestOutlookResearch/0.1; public agronomy pages, low volume)';

function decodeBody(buf: Buffer, contentType: string): string {
  const m = /charset=([\w-]+)/i.exec(contentType) ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'));
  const cs = (m?.[1] ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const log: unknown[] = [];
  for (const s of SOURCES) {
    if (only.size && !only.has(s.key)) continue;
    const base = join(RAW_DIR, s.key);
    if (existsSync(base + '.meta.json') && !process.env.REFETCH) {
      console.log(`skip (cached) ${s.key}`);
      continue;
    }
    const fetchedAt = new Date().toISOString();
    let status: number | null = null;
    let err: string | null = null;
    try {
      const res = await fetch(s.url, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
      status = res.status;
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') ?? '';
      const isPdf = /pdf/i.test(ct) || buf.subarray(0, 5).toString() === '%PDF-';
      const ext = isPdf ? 'pdf' : 'html';
      const sha256 = createHash('sha256').update(buf).digest('hex');
      if (res.ok) {
        writeFileSync(`${base}.${ext}`, buf);
        let text: string;
        if (isPdf) {
          text = execFileSync('pdftotext', ['-enc', 'UTF-8', `${base}.pdf`, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
        } else {
          text = htmlToText(decodeBody(buf, ct));
        }
        writeFileSync(`${base}.txt`, text);
        writeFileSync(`${base}.meta.json`, JSON.stringify({ key: s.key, url: s.url, finalUrl: res.url, status, contentType: ct, bytes: buf.length, sha256, fetchedAt, textChars: text.length }, null, 1));
      }
      log.push({ key: s.key, url: s.url, status, bytes: buf.length, sha256, fetchedAt });
    } catch (e) {
      err = String(e);
      log.push({ key: s.key, url: s.url, status, error: err, fetchedAt });
    }
    console.log(`${status ?? 'ERR'} ${s.key} ${s.url}${err ? ' ' + err : ''}`);
  }
  const logPath = join(RAW_DIR, 'fetch_log.json');
  const prev = existsSync(logPath) ? (JSON.parse(readFileSync(logPath, 'utf8')) as unknown[]) : [];
  writeFileSync(logPath, JSON.stringify([...prev, ...log], null, 1));
}
main();
