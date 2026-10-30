/**
 * Canonical market key for joining Agmarknet market series across source renames.
 * Observed 2026-10-30 (variety-wise resource, Karnataka ginger): from Nov 2025 the same markets appear as
 * "Hassan APMC", "Mysuru APMC", "Binny Mill (FF&V) Bengaluru APMC" with districts "Mysuru"/"Bengaluru" instead of
 * "Hassan", "Mysore (Bandipalya)", "Binny Mill (F&V), Bangalore" / "Mysore"/"Bangalore". Stored market_id stays
 * source-faithful (never rewritten); this key is for analysis and replay series construction only.
 * Only name-level normalisation is applied: same-name markets in different districts are NOT merged by this function
 * (callers pass the key together with their own district policy). Whether two renamed entries are the same physical
 * market is an inference from the name, not a source statement.
 */
export function canonicalMarketKey(marketName: string): string {
  const t = marketName
    .toLowerCase()
    .replace(/\(ff&v\)/g, "(f&v)")
    .replace(/\bapmc\b/g, " ")
    .replace(/bengaluru/g, "bangalore")
    .replace(/mysuru/g, "mysore")
    .replace(/shivamogga/g, "shimoga")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return t;
}
