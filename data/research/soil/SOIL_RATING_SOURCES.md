# Soil rating sources

Version 2026-11-01. Companion to `soil-ratings.json`. A figure with `verified: false` never rates a marker. "Verified" here means the figure was read directly in the cited document on 2026-11-01 (PDF text and page images), not recalled and not taken from a search snippet.

## Used for ratings (verified)

| Parameter | Bands | Source and locator |
| --- | --- | --- |
| Organic carbon, % | low below 0.5, medium 0.5 to 0.75, high above 0.75 | DAC, Methods Manual: Soil Testing in India (Jan 2011), Table 1, printed p. 33 (PDF p. 34) |
| Available N, kg/ha, alkaline permanganate | low below 280, medium 280 to 560, high above 560 | same Table 1 |
| Available P, kg P/ha, Olsen | low below 10, medium 10 to 24.6, high above 24.6 (the table says alkaline soil) | same Table 1 |
| Available K, kg K/ha, neutral N ammonium acetate | low below 108, medium 108 to 280, high above 280 | same Table 1 |
| P2O5 form, kg P2O5/ha | below 22.9, 22.9 to 56.334, above 56.334 | Table 1 element bands multiplied by 2.29 |
| K2O form, kg K2O/ha | below 129.6, 129.6 to 336, above 336 | Table 1 element bands multiplied by 1.20 |
| DTPA Zn | critical limit 0.6 ppm (printed 0.6, range 0.4 to 1.2) | DAC manual Table 6, printed p. 39 (PDF p. 40) |
| DTPA Mn | critical limit 2 ppm | Table 6 |
| DTPA or ammonium acetate Cu | critical limit 0.2 ppm | Table 6 |
| DTPA Fe | critical range 2.5 to 4.5 ppm (deficient below 2.5, sufficient above 4.5) | Table 6 |
| Hot-water B | critical limit 0.5 ppm | Table 6 |
| S (hot water, CaCl2 or phosphate) | usual critical level 10 ppm (range 8 to 30) | Table 6 |
| P to P2O5 x 2.29, K to K2O x 1.20, organic C x 1.724 = organic matter (organic matter x 0.580 = organic C), mg/kg = ppm | conversion factors | DAC manual conversion annex, printed pp. 189-190 (after Motsara and Roy 2008, FAO Fertilizer and Plant Nutrition Bulletin 19) |
| pH | below 5.6 strongly acidic (ultra to strongly acid, 5.5 and below), 5.6 to 6.5 acidic, 6.6 to 7.3 neutral, 7.4 to 8.4 alkaline, 8.5 and above strongly alkaline | USDA NRCS, Soil Survey Manual 2017, Table 3-15 Reaction Class Terms, printed pp. 199-200. URL https://www.nrcs.usda.gov/sites/default/files/2022-09/The-Soil-Survey-Manual.pdf |
| EC, dS/m | normal below 1, critical 1 to 2 (germination) and 2 to 4 (sensitive crops), injurious above 4 | TNAU Agritech Portal, Soil Rating Chart (c) TNAU 2016, https://agritech.tnau.ac.in/agriculture/agri_soil_soilratingchart.html |

The DAC manual copy read is the PDF hosted at https://biharsoilhealth.in/documents/manualgoi.pdf (217 pages, title "Final corrected manual on soil testing 09_03_11", cover "Methods Manual, Soil Testing in India, Department of Agriculture & Cooperation, Ministry of Agriculture, Government of India, New Delhi, January 2011"). The original agricoop.nic.in URL could not be resolved from this machine.

## Differences from ROUND2_SPEC 5.1 (the spec figures were from memory, the sources win)

- K low/medium boundary is 108 kg K/ha in the DAC manual (spec said 120).
- P high boundary is 24.6 kg P/ha (spec said 25).
- pH neutral is 6.6 to 7.3 in the NRCS table (spec said 6.5 to 7.5); the class edges 5.6, 6.6, 7.4 and 8.5 are the printed next-class lower limits.
- EC injurious is above 4 dS/m in the TNAU chart with a critical zone of 1 to 4 (spec said critical 1 to 2, injurious above 2). No source read supports injurious above 2.
- Iron is a critical range of 2.5 to 4.5 ppm in the manual, not a single 4.5 ppm limit; boron and sulphur critical levels are from the same table (0.5 and 10 ppm).

## Read and not used

| Source | What it says | Why not used |
| --- | --- | --- |
| DAC manual Table 14 (soil reaction ratings) | extremely acid below 4.6, strongly acid 4.6 to 5.5, moderately acid 5.6 to 6.5, slightly acid 6.6 to 6.9, neutral 7.0, moderately alkaline 7.1 to 8.5, strongly alkaline above 8.5 | neutral is a single value; no usable neutral band. Agrees with NRCS at 5.5/5.6, 6.5 and 8.5 |
| DAC manual Table 18 and 17 (EC) | salt-free 0 to 2 mS/cm; saline above 4 dS/m with ESP and pH | the Table 18 layout is garbled in the PDF text; classes could not be read with confidence |
| DAC manual Table 21 (DTPA micronutrients, after Lindsay and Norvell 1978) | five classes, for example Zn very low 0-0.5, low 0.5-1, medium 1-3, high 3-5, very high above 5; Cu 0-0.1, 0.1-0.3, 0.3-0.8, 0.8-3, above 3; Fe 0-2, 2-4, 4-6, 6-10, above 10; Mn 0-0.5, 0.5-1.2, 1.2-3.5, 3.5-6, above 6 | conflicts with the Table 6 critical limits for the same elements; the spec asks for critical limits |
| DAC manual Tables 2 and 3 (West Bengal and Maharashtra six classes, after Tandon 2005) | state-specific P2O5 and K2O classes | not the national table |
| Soil Health Card operational guidelines (DAC, 2015), sample card, https://www.sameti.org/Guidelines/CS%20on%20Soil%20Health%20Card.pdf | illustrative card: pH normal 6.5 to 8.2, EC normal below 1, medium 1 to 3, harmful above 3, P low below 28, K low below 140, S low below 10, Zn low below 0.5, Fe low below 5, Mn low below 5, Cu low below 0.2 | a sample card layout, not a stated rating standard; corroborates EC normal below 1 and OC 0.5 to 0.75 |
| TNAU Soil Rating Chart, nutrient rows | N 240/480, P 11/22, K 110/280 kg/ha; pH rows with gaps | differs from the national manual; the page also prints a typo for organic carbon (0.5 to 7.5) |
| ICRISAT, Soil Fertility Atlas for Karnataka (2011) | map legends use available P below 5 ppm deficient | a different, two-class research scheme |

## Not verified (never rates)

- Conversion of mg/kg to kg/ha at 2.24 (1 mg/kg = 2.24 kg/ha, about 2.24 million kg of soil per hectare): seen only in vendor and extension pages, not in a primary Indian manual. The DAC manual itself assumes about 2 million kg/ha for the surface 0 to 22 cm. Until a primary source and the depth and bulk density are confirmed, available N, P and K reported in mg/kg are `unit_mismatch`, not rated. Micronutrients, B and S need no conversion because mg/kg equals ppm.

## Rating rules in code

- Only markers with `reviewStatus` confirmed, `matrix` soil, an exact qualifier, a numeric canonical value and no unresolved review warnings are rated. Ranges, less-than and below-detection results are `qualifier`. A canonical unit that is not the band unit, or a missing canonical value for an exact result (for example a ppm result the normalizer would not convert), is `unit_mismatch`.
- Where the report states a method or extractant that differs from the one the band is defined for (Bray instead of Olsen, CaCl2 pH, non-DTPA micronutrients), the marker is `unrated` with the reason. Where no method is stated the band is applied and the assumption is returned in `note`.
- P and K rate on the P2O5 and K2O band sets only when the report names the oxide form; otherwise the element bands apply and `note` says so.
- `rateMarker` (strict) never rates organic matter, total N, P and K, unspecified nitrogen, exchangeable or water-extracted potassium.
- `rateMarkerAssumed` (used by the soil review) rates three of these on a flagged inference and returns an `assumption` string: unspecified N in kg/ha as available N, total P and total K in kg/ha as available P (Olsen) and K, and organic matter as organic carbon at 0.580 (the DAC conversion table, verified from the page image on 2026-11-01). Exchangeable or water-extracted potassium, and results in mg/kg for N, P and K, stay unrated.
- Rating describes the report value against the cited bands. It is not a fertilizer dose and not crop advice.
