"""Initial draft of data/manifests/crop-identities.json for the 25 PRD candidates.
Botanical names are standard taxonomy (not retrieved in T01). Source-native AGMARKNET commodity names are NOT verified (no keyed API access);
they are left as null with status 'unresolved' rather than guessed. Agronomy source statuses come from data/raw/crop_url_checks.json."""
import json, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[2]
chk = json.loads((ROOT / "data/raw/crop_url_checks.json").read_text())
def P(pid, name, basis, unit_hint, note=""):
    return {"productId": pid, "name": name, "basis": basis, "typicalTradeUnit": unit_hint, "agmarknetCommodityName": None, "agmarknetMappingStatus": "unresolved", "notes": note}
Q = "quintal (typical AGMARKNET; unverified)"
C = [
 ("paddy", "Paddy / rice", "cereals", ["Oryza sativa L."], [P("paddy.unhusked", "Paddy (unmilled)", "unhusked grain", Q), P("rice.milled", "Milled rice", "milled grain", Q, "Not interchangeable with paddy; milling outturn needed for conversion")]),
 ("wheat", "Wheat", "cereals", ["Triticum aestivum L.", "Triticum durum Desf."], [P("wheat.grain", "Wheat grain", "grain", Q, "Bread vs durum wheat may be separate varieties/grades")]),
 ("maize", "Maize", "cereals", ["Zea mays L."], [P("maize.grain", "Maize grain", "dry grain", Q), P("maize.green_cob", "Green maize cob", "fresh cob", "count/kg (unverified)", "Distinct fresh product")]),
 ("sorghum", "Sorghum (jowar)", "cereals", ["Sorghum bicolor (L.) Moench"], [P("sorghum.grain", "Jowar grain", "grain", Q, "Fodder sorghum excluded")]),
 ("pearl_millet", "Pearl millet (bajra)", "cereals", ["Cenchrus americanus (L.) Morrone (syn. Pennisetum glaucum (L.) R.Br.)"], [P("pearl_millet.grain", "Bajra grain", "grain", Q)]),
 ("finger_millet", "Finger millet (ragi)", "cereals", ["Eleusine coracana (L.) Gaertn."], [P("finger_millet.grain", "Ragi grain", "grain", Q)]),
 ("chickpea", "Chickpea (Bengal gram)", "pulses", ["Cicer arietinum L."], [P("chickpea.whole", "Chickpea whole grain", "whole seed", Q, "Desi vs kabuli are distinct market types"), P("chickpea.dal", "Chana dal", "split dehusked", Q, "Processed product")]),
 ("pigeon_pea", "Pigeon pea (red gram, tur/arhar)", "pulses", ["Cajanus cajan (L.) Millsp."], [P("pigeon_pea.whole", "Tur whole", "whole seed", Q), P("pigeon_pea.dal", "Tur dal", "split dehusked", Q, "Processed product")]),
 ("green_gram", "Green gram (moong)", "pulses", ["Vigna radiata (L.) R.Wilczek"], [P("green_gram.whole", "Moong whole", "whole seed", Q), P("green_gram.dal", "Moong dal", "split", Q)]),
 ("black_gram", "Black gram (urad)", "pulses", ["Vigna mungo (L.) Hepper"], [P("black_gram.whole", "Urad whole", "whole seed", Q), P("black_gram.dal", "Urad dal", "split", Q)]),
 ("lentil", "Lentil (masur)", "pulses", ["Lens culinaris Medik."], [P("lentil.whole", "Masur whole", "whole seed", Q), P("lentil.dal", "Masur dal", "split", Q)]),
 ("groundnut", "Groundnut", "oilseeds", ["Arachis hypogaea L."], [P("groundnut.pods", "Groundnut pods (in shell)", "pods", Q), P("groundnut.kernel", "Groundnut kernels", "shelled", Q, "Shelling outturn needed for conversion")]),
 ("soybean", "Soybean", "oilseeds", ["Glycine max (L.) Merr."], [P("soybean.seed", "Soybean seed", "seed", Q)]),
 ("mustard", "Rapeseed-mustard", "oilseeds", ["Brassica juncea (L.) Czern.", "Brassica rapa L.", "Brassica napus L."], [P("mustard.seed", "Mustard / rapeseed seed", "seed", Q, "Species mix; oil and cake are separate products")]),
 ("sesame", "Sesame (gingelly, til)", "oilseeds", ["Sesamum indicum L."], [P("sesame.seed", "Sesame seed", "seed", Q, "White/black seed may be separate varieties")]),
 ("sunflower", "Sunflower", "oilseeds", ["Helianthus annuus L."], [P("sunflower.seed", "Sunflower seed", "seed", Q)]),
 ("potato", "Potato", "vegetables", ["Solanum tuberosum L."], [P("potato.fresh", "Potato tubers", "fresh", Q, "Seed potato is a distinct product")]),
 ("onion", "Onion", "vegetables", ["Allium cepa L.", "Allium cepa var. aggregatum G.Don (small/multiplier onion)"], [P("onion.big", "Big (Bellary) onion", "fresh bulbs", Q), P("onion.small", "Small / multiplier onion", "fresh bulbs", Q, "Different crop cycle and market; TNAU has separate pages")]),
 ("tomato", "Tomato", "vegetables", ["Solanum lycopersicum L."], [P("tomato.fresh", "Tomato", "fresh", "quintal or crate (unverified)", "Highly perishable; grade matters")]),
 ("brinjal", "Brinjal (eggplant)", "vegetables", ["Solanum melongena L."], [P("brinjal.fresh", "Brinjal", "fresh", Q, "Repeated pickings")]),
 ("okra", "Okra (bhindi, bhendi)", "vegetables", ["Abelmoschus esculentus (L.) Moench"], [P("okra.fresh", "Okra pods", "fresh", Q, "Repeated pickings")]),
 ("chilli", "Chilli", "spices", ["Capsicum annuum L.", "Capsicum frutescens L."], [P("chilli.green", "Green chilli", "fresh", Q, "Repeated pickings"), P("chilli.dry_red", "Dry red chilli", "dried", Q, "Distinct product; dry:fresh conversion needed")]),
 ("ginger", "Ginger", "spices", ["Zingiber officinale Roscoe"], [P("ginger.fresh", "Fresh (green) ginger rhizome", "fresh", Q, "Demo product for visual journey"), P("ginger.dry", "Dry ginger (sonth)", "dried, peeled/unpeeled", Q, "Distinct product; IISR guide covers both uses"), P("ginger.seed_rhizome", "Seed rhizome", "fresh planting material", "kg", "Input cost, not a sale product")]),
 ("turmeric", "Turmeric", "spices", ["Curcuma longa L."], [P("turmeric.fresh", "Fresh turmeric rhizome", "fresh", Q), P("turmeric.cured", "Cured dried turmeric (finger/bulb)", "boiled and dried", Q, "Finger vs bulb grades differ")]),
 ("cotton", "Cotton", "fibre", ["Gossypium hirsutum L.", "Gossypium arboreum L.", "Gossypium herbaceum L.", "Gossypium barbadense L."], [P("cotton.kapas", "Kapas (seed cotton)", "unginned", Q, "Farmer sale product"), P("cotton.lint", "Cotton lint", "ginned", "bale of 170 kg (trade convention; unverified here)", "Not a farm-gate product; ginning outturn needed"), P("cotton.seed", "Cottonseed", "seed", Q)]),
]
crops = []
for cid, common, group, bot, prods in C:
    srcs = chk.get(cid, [])
    hard = [s["url"] for s in srcs if s["status"] == 200 and not s.get("soft200")]
    crops.append({"cropId": cid, "commonName": common, "group": group, "botanicalNames": bot, "marketProducts": prods,
      "agronomySourceCandidates": [{"url": s["url"], "httpStatus": s["status"], "soft200": s.get("soft200", False), "checkedAt": s["checkedAt"]} for s in srcs],
      "agronomySourceStatus": "candidate_reachable" if hard else "no_verified_source",
      "qualificationStatus": "draft_not_qualified",
      "notes": "Reachability only; content, region and season scope not reviewed. Not counted toward the 25-crop target." })
out = {"schemaVersion": 1, "auditTask": "T01", "status": "initial_draft", "generatedBy": "scripts/audit/build_crop_identities.py",
       "caveats": ["Botanical names are standard taxonomy entered by the auditor, not extracted from a retrieved source.",
                   "agmarknetCommodityName left null: commodity/variety strings were not observed in any retrieved row.",
                   "Trade units marked 'unverified' are typical conventions, not measured from data."], "crops": crops}
(ROOT / "data/manifests/crop-identities.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
for c in crops: print(f"{c['cropId']:14s} {c['agronomySourceStatus']:22s} products={len(c['marketProducts'])}")
