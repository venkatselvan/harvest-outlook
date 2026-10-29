import type { Alias, CropIdentity, CropProduct, ProductBasis, ToolOutput } from '@harvest/contracts';

/**
 * Alias resolution. Returns every plausible candidate; never forces a match.
 * A match on a product alias (e.g. "kapas", "dry ginger") yields that productId.
 * A match on a crop-level alias returns productId null plus all of the crop's
 * products, so the caller must clarify the product basis (fresh vs dry etc.).
 */
export function normalizeAlias(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Candidate = ToolOutput<'resolve_crop_identity'>['candidates'][number];
type MatchKind = Candidate['matchKind'];

const RANK: Record<MatchKind, number> = { exact: 0, normalized: 1, prefix: 2 };

function matchAlias(query: string, alias: Alias): MatchKind | null {
  if (alias.text === query) return 'exact';
  const q = normalizeAlias(query);
  const a = normalizeAlias(alias.text);
  if (q.length === 0) return null;
  if (a === q) return 'normalized';
  if (q.length >= 3 && a.startsWith(q)) return 'prefix';
  return null;
}

export interface ResolveOptions {
  /** Preferred language; candidates in other languages are still returned. */
  language?: string;
  /** Include prefix matches (autocomplete). Default false. */
  allowPrefix?: boolean;
}

export function resolveCropIdentity(
  text: string,
  crops: CropIdentity[],
  products: CropProduct[],
  opts: ResolveOptions = {},
): ToolOutput<'resolve_crop_identity'> {
  const productsByCrop = new Map<string, { productId: string; productBasis: ProductBasis }[]>();
  for (const p of products) {
    const list = productsByCrop.get(p.cropId) ?? [];
    list.push({ productId: p.id, productBasis: p.productBasis });
    productsByCrop.set(p.cropId, list);
  }
  const found = new Map<string, Candidate & { rank: number; langPenalty: number }>();
  const consider = (cropId: string, productId: string | null, alias: Alias) => {
    const kind = matchAlias(text, alias);
    if (kind === null || (kind === 'prefix' && !opts.allowPrefix)) return;
    const key = `${cropId}|${productId ?? ''}`;
    const rank = RANK[kind];
    const langPenalty = opts.language !== undefined && alias.language !== opts.language ? 1 : 0;
    const prev = found.get(key);
    if (prev && (prev.rank < rank || (prev.rank === rank && prev.langPenalty <= langPenalty))) return;
    found.set(key, {
      cropId,
      productId,
      matchedAlias: alias.text,
      aliasLanguage: alias.language,
      matchKind: kind,
      products: productId === null ? (productsByCrop.get(cropId) ?? []) : (productsByCrop.get(cropId) ?? []).filter((p) => p.productId === productId),
      rank,
      langPenalty,
    });
  };
  for (const c of crops) for (const a of [...c.commonNames, ...c.aliases]) consider(c.id, null, a);
  for (const p of products) {
    for (const a of p.aliases) consider(p.cropId, p.id, a);
    consider(p.cropId, p.id, { text: p.name, language: 'en', kind: 'common', sourceIds: [] });
  }

  const all = [...found.values()];
  const best = Math.min(...all.map((c) => c.rank), Infinity);
  const candidates = all
    .filter((c) => c.rank === best)
    .sort((a, b) => a.langPenalty - b.langPenalty || a.cropId.localeCompare(b.cropId) || (a.productId ?? '').localeCompare(b.productId ?? ''))
    .map(({ rank: _r, langPenalty: _l, ...c }) => c);

  const cropIds = new Set(candidates.map((c) => c.cropId));
  const productAmbiguous = candidates.some((c) => c.productId === null && c.products.length > 1);
  const ambiguous = cropIds.size > 1 || productAmbiguous || candidates.length > 1;
  return {
    candidates,
    ambiguous,
    unresolvedReason: candidates.length === 0 ? 'no_alias_match' : ambiguous ? (cropIds.size > 1 ? 'multiple_crops_match' : 'product_basis_unresolved') : null,
  };
}
