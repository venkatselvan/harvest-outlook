# Pre-registered holdout policy: Karnataka ginger (fresh) real-data replay

Case: `ginger-karnataka-2026-10-30`. Task T07b. Written 2026-10-30 and committed **before** any replay was run and before any
price series was inspected beyond the L2 audit tables in `docs/MARKET_AUDIT_GINGER.md` and
`data/manifests/market-coverage-ginger.json` (coverage counts and season medians only; no forecast or score was computed).
The git commit of this file is the timestamp proof of order. Any later change to this file is a policy amendment: it
must be a separate commit, state its reason, and be disclosed in the report. The machine-readable form is `request.json`
in this directory; if the two disagree, this file governs and the disagreement is a defect to report.

## 1 Product and markets

- Source: data.gov.in variety-wise mandi resource `35985678-0d79-46b4-9ed6-6f13308a1d24` (Agmarknet), state Karnataka,
  commodity `Ginger(Green)` mapped to product `ginger-fresh`. `Ginger(Dry)` (`ginger-dry`) is never mixed in.
- Scored markets (canonical IDs; source `market_id` values are joined across the Nov 2025 " APMC" renames by the pinned
  alias table in `request.json`, which follows `canonicalMarketKey` in `apps/api/src/providers/datagovin/market-alias.ts`):
  1. `agmarknet:ka:binny-mill-fv-bengaluru`: Binny Mill (F&V), Bangalore and its renames. Primary, dense series.
  2. `agmarknet:ka:belur`: Belur and Belur APMC (Hassan district). Demonstration market, lower confidence (L2 audit: 3
     median trading days per active week, a 350-day gap since 2019).
  3. `agmarknet:ka:ramanagara`: Ramanagara and Ramanagara APMC (district Bangalore, renamed Bengaluru South). Third
     scored market.
- Hassan market itself is **not** scored: its level (~1,500 INR/quintal) is unexplained against ~4,500 elsewhere (L2).
- Unit: the source states no unit. INR/quintal is assumed by the Agmarknet convention and converted to INR/kg by /100.

## 2 Decision cutoffs, targets and horizons

- Decision cutoffs (planting decision for a May planting): 1 May 2021, 2022, 2023, 2024, 2025, at 00:00 Asia/Kolkata.
- Target: weekly median of valid daily modal quotes, INR/kg (`weekly_median_modal`). Daily value = median modal across
  all variety/grade rows of that market on that day.
- Harvest window: ISO weeks 48 of the cutoff year through ISO week 8 of the next year (Monday of week 48 to Sunday of
  week 8, i.e. late Nov to late Feb), consistent with a 210 to 240 day crop duration from a May planting.
- Horizons: counted from the origin week (last complete ISO week before the cutoff). With these windows the horizons are
  about 31 to 44 weeks (the task brief said 30 to 40; the exact horizons follow from the window). `horizonWeeks` is set
  to 45 so every week of the window is a target. No target is dropped for horizon.

## 3 Training

- Expanding window. Price rows observed before 2010-01-01 are excluded (training start 2010; counted). Labels are complete
  weeks ending before the cutoff local date. `minTrainWeeks` 80 (T07 default).

## 4 Models (configuration fixed; T07 synthetic-chosen defaults, disclosed)

All parameters are the T07 defaults in `analytics/harvest_analytics/forecast/replay.py` `DEFAULT_MODEL_CONFIG`, which
were chosen on synthetic development data only. They are not tuned here and will not be tuned after test scores exist.

- `A_last_value`: last valid daily modal quote available at the cutoff; `maxStaleWeeks` 3 (abstains when stale);
  `minResidualPairs` 12.
- `B_seasonal_reference`: median of training values in the same ISO week; `minSeasonYears` 2; `isoWeekWindow` 0.
- `C_base`: anchor = median log value of the same week in up to 5 prior years; ridge (`ridgeAlpha` 1.0) on origin anomaly
  and Fourier order 2; inner temporal calibration split of 52 weeks; `minFitPairs` 26; `minCalibrationPairs` 12.
- `C_weather`: `C_base` plus the 8-week observed precipitation anomaly for the Hassan supply region, lagged 2 weeks,
  climatology from training weeks only. All three markets map to the Hassan region (assumption: Hassan district is a
  principal Karnataka ginger supply area; Bengaluru markets also draw on other districts; not sourced as a market share).
- `C_snaive`: the spec variant (single-year anchor), reported as secondary. Not eligible for release under section 7.
- `C_satellite`: always abstains (no validated satellite transform). Reported as abstentions.
- `C_arrivals` is not run: the export carries `arrivals: null` (arrivals are not used in this case).
- If a market's series is too sparse, models abstain with their own reasons; abstentions are reported, never filled.

## 5 Availability policy (assumption, disclosed)

- Stored `available_at` for every price row is the 2026-10-30 fetch time (conservative upper bound). Under that value no
  historical cutoff could see any row, so the replay assigns `availableAt = observedOn + 1 day` (00:00 UTC+05:30 of the
  next day, expressed in UTC) with `availableAtBasis: "assumed_publication_lag_1d"`. This assumes next-day Agmarknet
  publication. It is **not** a recorded publication time. Every report must state it.
- Revisions: rows are exported from vintage 1. A later stored vintage (if any) is exported with `revisionOf` = the
  vintage-1 row and its own recorded fetch time as `availableAt` (basis `recorded`), so cutoffs see the first vintage and
  realized targets use the latest.
- Weather: Open-Meteo archive (reanalysis, not station data) for Hassan (13.00, 76.10 after 0.01 degree rounding), stored
  with fetch-time `available_at`. For replay, `availableAt = date + 6 days` with basis `assumed_reanalysis_lag_6d`
  (archive documented ~5-day delay plus one day margin). The model's 2-week lag is applied on top.

## 6 Exclusions (counted by reason, applied in this order, before replay)

1. `validation_status != 'valid'` (e.g. `unverified_mapping`).
2. Modal below 300 INR/quintal (looks per-kg or mis-scaled; ginger is never < INR 3/kg).
3. 10x scaling flag: modal more than 3.5x above or below 0.25x the Karnataka-wide median modal of ginger-fresh valid rows in
   the same calendar month (the L2 audit rule). This uses same-month cross-market data; it is a cleaning rule, disclosed.
4. Price-order violations: min > modal, modal > max, or min > max.
5. Observed before 2010-01-01.
Rows of non-scored markets are kept in the export but are outside the scored set.

## 7 Metrics, reporting and release rule

- Metrics: MAE (INR/kg), MASE (scale = mean |y_t - y_t-52| over that replay's training weeks), pinball loss q10/q50/q90,
  WIS80, empirical coverage of [q10, q90], mean width, abstentions with reasons, unscored targets with no realized value;
  per market, per season, per horizon; paired common-set comparison; season-block bootstrap 90% MAE interval only when
  >= 5 seasons are scored. Everything is reported, including failures, abstentions and unfavourable results.
- Release rule per market (fixed now): compare on the per-market common set of targets scored by A, B, C_base (and
  C_weather for the weather decision). A C variant is chosen only if it beats the better baseline on **both** MAE and
  WIS80 on that common set, has coverage80 >= 0.60 and the common set has >= 20 targets. Otherwise the release uses the
  baseline (A or B) with the lower WIS80 on its own scored targets (MAE breaks ties). `C_weather` is adopted over `C_base`
  only if it beats `C_base` on both MAE and WIS80 on their common set. If both baselines abstain for a market, the
  release shows no evaluated forecast for that market (scenario only).
- No hyperparameter, window, exclusion rule or market choice changes after test scores are seen. Bugs found after scoring
  may be fixed only with a disclosed amendment, and the pre-fix results are kept.

## 8 Known limitations stated in advance

Subset of upstream rows (the L2 ingest was page-capped and the API order is not chronological); availability assumed, not
recorded; unit assumed INR/quintal; Hassan-district level anomaly unexplained; market renames joined by name inference;
modal price is a wholesale reference, not farm-gate; 5 seasons x 3 markets is a small sample; weather is reanalysis.
