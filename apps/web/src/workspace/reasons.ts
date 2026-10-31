/** Human-readable data gaps; the API continues to retain its diagnostic reason codes. */
export function sourceReason(reason: string | null | undefined): string {
  if (!reason) return "";
  const labels: Record<string, string> = {
    ok: "Provider responded successfully",
    not_checked:
      "No new provider request was made in this check; any displayed quotes retain their source date.",
    price_history_not_ingested:
      "A historical price series has not been collected for this crop and region. Check latest dated quotes separately.",
    price_history_insufficient:
      "There are too few dated trading days to calculate a historical range. A latest quote can still be shown separately.",
    no_verified_commodity_mapping:
      "This crop product has no verified match to an AGMARKNET commodity. A quote is not assigned from a different crop.",
    no_matching_current_quote:
      "The provider returned no exact commodity and location match in the checked records.",
    no_exact_quote_in_bounded_response:
      "The provider response contained no exact match within this bounded check. Broader coverage may exist outside the returned records.",
    no_selected_or_recommended_products:
      "Add a crop choice or wait for Evara's recommendations so the correct commodity can be checked.",
    bounded_refresh_budget_exhausted:
      "This refresh reached its provider request limit. Returned quotes are kept; other products can be checked on the next refresh.",
    api_key_missing:
      "The mandi provider API key is not configured, so a live quote request cannot be made.",
    rate_limited:
      "The mandi provider is rate limiting requests. Saved dated quotes remain visible; try again after the provider cooldown.",
    timeout:
      "The mandi provider did not respond before the request timeout. Try refreshing again.",
    network_error:
      "The mandi provider could not be reached. Try refreshing again.",
    not_refreshed:
      "No current provider check has been completed for this product. Refresh dated quotes to check it.",
    disabled_mode: "Live mandi fetching is disabled in this runtime mode.",
    no_matching_market:
      "No matching mandi with dated quotes is available for this farm yet.",
    no_market_mapping:
      "A verified local mandi has not been linked to this crop yet.",
    no_price_observations:
      "No dated price observations are stored for this product yet.",
    no_products_tracked:
      "Add a crop to your rotation or field journal to track its available market references.",
    farm_coordinates_missing:
      "Map your farm boundary to get a local weather outlook.",
    farm_location_unavailable:
      "Map your farm boundary to get a local weather outlook.",
    forecast_unavailable:
      "A local weather forecast could not be obtained at this time.",
    live_meta_requires_live_mode:
      "Live AI reviews are available when the app is running in live mode.",
    meta_key_missing: "The live assistant provider is not configured.",
    no_verified_market_mapping:
      "A verified local mandi mapping is not available. Stored references are retained with their quote dates.",
  };
  if (labels[reason]) return labels[reason]!;
  if (reason.includes("price_history_not_ingested"))
    return labels.price_history_not_ingested!;
  if (reason.includes("no_verified") && reason.includes("market"))
    return labels.no_verified_market_mapping!;
  return reason.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function priceGapTitle(reason: string | null | undefined): string {
  if (
    /rate_limited|timeout|network|http_error|provider_error|request_failed|unavailable/.test(
      reason ?? "",
    )
  )
    return "Mandi provider could not return a quote";
  if (/mapping/.test(reason ?? ""))
    return "Crop-to-market mapping needs verification";
  if (reason === "price_history_insufficient")
    return "Not enough price history";
  if (/no_matching_current_quote|no_exact_quote/.test(reason ?? ""))
    return "No exact matching quote was returned";
  if (/no_selected_or_recommended|no_products/.test(reason ?? ""))
    return "Choose a crop to check mandi quotes";
  return "No dated quote returned";
}
