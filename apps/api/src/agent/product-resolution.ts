/**
 * L5 server rule for the product form of a crop in one assistant turn. Resolution order:
 *   1. the selected plan's product (when it belongs to the crop),
 *   2. an explicit fresh/dry mention in the farmer's text (only when exactly one form is mentioned and the crop has it),
 *   3. crop level (productId null): enough for agronomy, water, soil and timing questions; only a price/market
 *      question then needs the farmer to name the product form.
 * Pure function; the loop attaches the result to resolve_crop_identity tool views and to the request context.
 */
export type ProductResolutionSource = "plan" | "explicit_mention" | "single_product" | "crop_level";
export interface ProductResolution {
  cropId: string;
  productId: string | null;
  productBasis: string | null;
  source: ProductResolutionSource;
  /** True only for price/market intents left at crop level: the one question worth asking is the product form. */
  askProductForm: boolean;
}

const DRY = [/\bdry\b/i, /\bdried\b/i, /\bsonth\b/i, /\bsoonth\b/i, /\bsukku\b/i, /\bchukku\b/i, /सोंठ/u, /सूख/u, /सुखा/u, /சுக்கு/u, /உலர்/u];
const FRESH = [/\bfresh\b/i, /\bgreen ginger\b/i, /ताज़ा|ताजा|ताज़ी|ताजी|ताज़े|ताजे/u, /हरी अदरक|हरा अदरक/u, /பச்சை/u, /புதிய/u];

/** The single product form the farmer explicitly named, or null (none, or both named). */
export function mentionedProductBasis(text: string): "dry" | "fresh" | null {
  const t = text.normalize("NFC");
  const dry = DRY.some((r) => r.test(t));
  const fresh = FRESH.some((r) => r.test(t));
  return dry === fresh ? null : dry ? "dry" : "fresh";
}

export const MARKET_INTENTS: ReadonlySet<string> = new Set(["market_question"]);

export function resolveTurnProduct(
  cropId: string,
  products: readonly { productId: string; productBasis: string }[],
  opts: { planProductIds: readonly string[]; userText: string; intent: string | null },
): ProductResolution {
  const plan = products.find((p) => opts.planProductIds.includes(p.productId));
  if (plan) return { cropId, productId: plan.productId, productBasis: plan.productBasis, source: "plan", askProductForm: false };
  const basis = mentionedProductBasis(opts.userText);
  const named = basis ? products.filter((p) => p.productBasis === basis) : [];
  if (named.length === 1) return { cropId, productId: named[0]!.productId, productBasis: basis, source: "explicit_mention", askProductForm: false };
  if (products.length === 1) return { cropId, productId: products[0]!.productId, productBasis: products[0]!.productBasis, source: "single_product", askProductForm: false };
  return { cropId, productId: null, productBasis: null, source: "crop_level", askProductForm: opts.intent !== null && MARKET_INTENTS.has(opts.intent) };
}
