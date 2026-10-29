// District / state / agro-region registry (data/curated/districts.json).
// Usage: pnpm --filter @harvest/scripts exec tsx catalogue/build-districts.ts
// District lists for Tamil Nadu, Assam and Karnataka are checked against saved public government pages
// (data/raw/districts, gitignored, sha256 + fetch time in *.meta.json). Other states are state-level only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, htmlToText, normaliseForMatch } from './common.ts';

const RAW = join(ROOT, 'data', 'raw', 'districts');
const UA = 'Mozilla/5.0 (compatible; HarvestOutlookResearch/0.1; public government pages, low volume)';
interface Src { key: string; url: string; publisher: string }
const SRC: Src[] = [
  { key: 'tn-gov-districts', url: 'https://www.tn.gov.in/district_list.php', publisher: 'Government of Tamil Nadu (tn.gov.in)' },
  { key: 'assam-gov-districts', url: 'https://assam.gov.in/districts-page.html', publisher: 'Government of Assam (State Portal)' },
  { key: 'karnataka-gov-districts', url: 'https://karnataka.gov.in/district/en', publisher: 'Government of Karnataka (karnataka.gov.in)' },
];

async function fetchSrc(s: Src) {
  const base = join(RAW, s.key);
  if (existsSync(base + '.meta.json')) return;
  mkdirSync(RAW, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const res = await fetch(s.url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${s.url} -> ${res.status}`);
  writeFileSync(base + '.html', buf);
  const text = htmlToText(buf.toString('utf8'));
  writeFileSync(base + '.txt', text);
  writeFileSync(base + '.meta.json', JSON.stringify({ key: s.key, url: s.url, status: res.status, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), fetchedAt }, null, 1));
}
const loadTxt = (key: string) => ({ text: readFileSync(join(RAW, key + '.txt'), 'utf8'), meta: JSON.parse(readFileSync(join(RAW, key + '.meta.json'), 'utf8')) });

type L = { en: string; ta?: string; hi?: string };
const states: Record<string, L> = {
  AP: { en: 'Andhra Pradesh', hi: 'आंध्र प्रदेश', ta: 'ஆந்திரப் பிரதேசம்' }, AR: { en: 'Arunachal Pradesh' }, AS: { en: 'Assam', hi: 'असम', ta: 'அசாம்' },
  BR: { en: 'Bihar', hi: 'बिहार', ta: 'பிகார்' }, CG: { en: 'Chhattisgarh' }, GA: { en: 'Goa' }, GJ: { en: 'Gujarat', hi: 'गुजरात', ta: 'குஜராத்' },
  HR: { en: 'Haryana', hi: 'हरियाणा', ta: 'ஹரியானா' }, HP: { en: 'Himachal Pradesh' }, JH: { en: 'Jharkhand' }, KA: { en: 'Karnataka', hi: 'कर्नाटक', ta: 'கர்நாடகா' },
  KL: { en: 'Kerala', hi: 'केरल', ta: 'கேரளா' }, MP: { en: 'Madhya Pradesh', hi: 'मध्य प्रदेश', ta: 'மத்தியப் பிரதேசம்' }, MH: { en: 'Maharashtra', hi: 'महाराष्ट्र', ta: 'மகாராஷ்டிரா' },
  MN: { en: 'Manipur' }, ML: { en: 'Meghalaya' }, MZ: { en: 'Mizoram' }, NL: { en: 'Nagaland' }, OD: { en: 'Odisha', hi: 'ओडिशा', ta: 'ஒடிசா' },
  PB: { en: 'Punjab', hi: 'पंजाब', ta: 'பஞ்சாப்' }, RJ: { en: 'Rajasthan', hi: 'राजस्थान', ta: 'ராஜஸ்தான்' }, SK: { en: 'Sikkim' },
  TN: { en: 'Tamil Nadu', hi: 'तमिलनाडु', ta: 'தமிழ்நாடு' }, TS: { en: 'Telangana', hi: 'तेलंगाना', ta: 'தெலங்கானா' }, TR: { en: 'Tripura' },
  UP: { en: 'Uttar Pradesh', hi: 'उत्तर प्रदेश', ta: 'உத்தரப் பிரதேசம்' }, UK: { en: 'Uttarakhand' }, WB: { en: 'West Bengal', hi: 'पश्चिम बंगाल', ta: 'மேற்கு வங்காளம்' },
};
const slug = (n: string) => n.toLowerCase().replace(/^the /, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Karnataka's page prints names split across lines ("Dakshina / Kannada"); the 31-district list is
// written out here and each entry is verified against the saved page by its first word.
const KA = ['Bagalkot', 'Ballari', 'Belagavi', 'Bengaluru Rural', 'Bengaluru Urban', 'Bidar', 'Chamarajanagar', 'Chikkaballapura', 'Chikkamagaluru', 'Chitradurga', 'Dakshina Kannada', 'Davanagere', 'Dharwad', 'Gadag', 'Hassan', 'Haveri', 'Kalaburagi', 'Kodagu', 'Kolar', 'Koppal', 'Mandya', 'Mysuru', 'Raichur', 'Ramanagara', 'Shivamogga', 'Tumakuru', 'Udupi', 'Uttara Kannada', 'Vijayanagara', 'Vijayapura', 'Yadgir'];
const KA_PAGE_TOKEN: Record<string, string> = { Chikkaballapura: 'chikkb', Yadgir: 'yadagiri', 'Bengaluru Urban': 'bengaluru', 'Bengaluru Rural': 'bengaluru' };

async function main() {
  for (const s of SRC) await fetchSrc(s);
  const tn = loadTxt('tn-gov-districts');
  const as = loadTxt('assam-gov-districts');
  const ka = loadTxt('karnataka-gov-districts');
  const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);
  const tnL = lines(tn.text); const tnNames = tnL.slice(tnL.indexOf('Ariyalur'), tnL.findIndex((l) => l.startsWith('Content owned')));
  const asL = lines(as.text); const asNames = asL.slice(asL.indexOf('Bajali'), asL.indexOf('Most Searched'));
  const kaNorm = normaliseForMatch(ka.text);
  const missing = KA.filter((n) => !kaNorm.includes(KA_PAGE_TOKEN[n] ?? normaliseForMatch(n.split(' ')[0]!)));
  if (missing.length) throw new Error('Karnataka names not on saved page: ' + missing.join(', '));
  if (tnNames.length !== 38) throw new Error(`expected 38 TN districts, got ${tnNames.length}`);
  if (KA.length !== 31) throw new Error('expected 31 KA districts');
  const out: any[] = [];
  const meta = (m: any, pub: string) => ({ sourceId: m.key, sourceUrl: m.url, publisher: pub, contentHash: m.sha256, fetchedAt: m.fetchedAt });
  for (const [code, n] of Object.entries(states)) {
    out.push({ id: `IN-${code}`, level: 'state', stateId: `IN-${code}`, names: n, source: 'iso_3166_2_in_state_code', note: 'State code per ISO 3166-2:IN; name is the commonly used English name.', validationStatus: 'pending' });
  }
  const add = (code: string, names: string[], src: Src, m: any, extra: Record<string, L> = {}) => {
    for (const name of names) {
      out.push({ id: `IN-${code}-${slug(name)}`, level: 'district', stateId: `IN-${code}`, names: { en: name, ...extra[name] }, source: meta(m, src.publisher), validationStatus: 'pending' });
    }
  };
  add('TN', tnNames, SRC[0]!, tn.meta);
  add('AS', asNames, SRC[1]!, as.meta);
  add('KA', KA, SRC[2]!, ka.meta, { Hassan: { en: 'Hassan', hi: 'हासन', ta: 'ஹாசன்' } });
  out.push({ id: 'IN-region-west-coast', level: 'region', stateId: null, names: { en: 'West Coast of India' }, source: 'iisr_ginger_guide_2025_wording', note: 'Agro-region wording from the ICAR-IISR ginger guide; no boundary or member-district list is sourced, so no district resolves to it.', validationStatus: 'pending' });
  out.push({ id: 'IN', level: 'national', stateId: null, names: { en: 'India', hi: 'भारत', ta: 'இந்தியா' }, source: 'iso_3166_1', validationStatus: 'pending' });
  const counts = { states: out.filter((o) => o.level === 'state').length, districts: out.filter((o) => o.level === 'district').length, byState: { 'IN-KA': KA.length, 'IN-TN': tnNames.length, 'IN-AS': asNames.length } };
  writeFileSync(join(ROOT, 'data', 'curated', 'districts.json'), JSON.stringify({ schemaVersion: '1.0', generatedBy: 'scripts/catalogue/build-districts.ts', note: 'District lists exist only for Karnataka, Tamil Nadu and Assam; other states are state-level only. Tamil/Hindi names are given only where confident; absent = not provided.', counts, areas: out }, null, 1) + '\n');
  console.log(JSON.stringify(counts));
}
await main();
