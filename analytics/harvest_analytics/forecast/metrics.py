"""Forecast scoring. Every summary carries its denominators.

Definitions (alpha = 0.2 for the central 80% interval [q10, q90]):
  pinball_tau(y, q) = max(tau * (y - q), (tau - 1) * (y - q))
  IS_alpha(y, l, u) = (u - l) + (2/alpha)(l - y)[y < l] + (2/alpha)(y - u)[y > u]
  WIS = (0.5 * |y - m| + (alpha/2) * IS_alpha) / (K + 0.5), K = 1 interval, m = q50
  MASE = mean(|y - q50| / scale), scale = in-sample mean |y_t - y_{t-52}| on the training weeks of
         that replay (seasonal naive, training data only).
"""

from __future__ import annotations

from typing import Any, Iterable

import numpy as np

ALPHA = 0.2
TAUS = {"q10": 0.1, "q50": 0.5, "q90": 0.9}
MIN_SEASONS_FOR_CI = 5


def pinball(y: np.ndarray, q: np.ndarray, tau: float) -> np.ndarray:
    d = np.asarray(y, float) - np.asarray(q, float)
    return np.maximum(tau * d, (tau - 1) * d)


def interval_score(y: np.ndarray, lo: np.ndarray, hi: np.ndarray, alpha: float = ALPHA) -> np.ndarray:
    y, lo, hi = (np.asarray(a, float) for a in (y, lo, hi))
    return (hi - lo) + (2 / alpha) * (lo - y) * (y < lo) + (2 / alpha) * (y - hi) * (y > hi)


def wis(y: np.ndarray, lo: np.ndarray, med: np.ndarray, hi: np.ndarray, alpha: float = ALPHA) -> np.ndarray:
    y, med = np.asarray(y, float), np.asarray(med, float)
    return (0.5 * np.abs(y - med) + (alpha / 2) * interval_score(y, lo, hi, alpha)) / 1.5


def covered(y: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    y = np.asarray(y, float)
    return (np.asarray(lo, float) <= y) & (y <= np.asarray(hi, float))


def mase_scale(train_values: np.ndarray, season: int = 52) -> float | None:
    v = np.asarray(train_values, float)
    if v.size <= season:
        return None
    d = np.abs(v[season:] - v[:-season])
    d = d[np.isfinite(d)]
    if d.size == 0:
        return None
    s = float(d.mean())
    return s if s > 0 else None


def score_record(pred: dict[str, Any], realized: float | None, scale: float | None) -> dict[str, Any]:
    out = dict(pred)
    out["realized"] = realized
    out["maseScale"] = scale
    if pred["abstained"] or realized is None:
        out["scored"] = False
        return out
    q = pred["quantiles"]
    y = realized
    out["scored"] = True
    out["absError"] = abs(y - q["q50"])
    out["scaledAbsError"] = (out["absError"] / scale) if scale else None
    out["pinball"] = {k: float(pinball(y, q[k], t)) for k, t in TAUS.items()}
    out["wis80"] = float(wis(y, q["q10"], q["q50"], q["q90"]))
    out["covered80"] = bool(covered(y, q["q10"], q["q90"]))
    out["width80"] = q["q90"] - q["q10"]
    return out


def _r(x: float | None, nd: int = 4) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def summarize(records: list[dict[str, Any]], *, rng_seed: int = 0) -> dict[str, Any]:
    n = len(records)
    abst = [r for r in records if r["abstained"]]
    reasons: dict[str, int] = {}
    for r in abst:
        reasons[r["abstainReason"]] = reasons.get(r["abstainReason"], 0) + 1
    predicted = [r for r in records if not r["abstained"]]
    missing_real = [r for r in predicted if r["realized"] is None]
    sc = [r for r in records if r.get("scored")]
    out: dict[str, Any] = {
        "nTargets": n, "nAbstained": len(abst), "abstainReasons": dict(sorted(reasons.items())),
        "nPredicted": len(predicted), "nUnscoredMissingRealized": len(missing_real), "nScored": len(sc),
        "nNegativeQuantilesReported": sum(1 for r in predicted if r.get("negativeQuantilesReported")),
        "mae": None, "mase": None, "nMase": 0, "pinball": None, "wis80": None,
        "coverage80": None, "meanWidth80": None, "maeCI90": None, "ciNote": None,
    }
    if not sc:
        out["ciNote"] = "no scored predictions"
        return out
    ae = np.array([r["absError"] for r in sc])
    scaled = [r["scaledAbsError"] for r in sc if r["scaledAbsError"] is not None]
    out["mae"] = _r(ae.mean())
    out["mase"] = _r(np.mean(scaled)) if scaled else None
    out["nMase"] = len(scaled)
    out["pinball"] = {k: _r(np.mean([r["pinball"][k] for r in sc])) for k in TAUS}
    out["wis80"] = _r(np.mean([r["wis80"] for r in sc]))
    out["coverage80"] = _r(np.mean([r["covered80"] for r in sc]))
    out["meanWidth80"] = _r(np.mean([r["width80"] for r in sc]))
    seasons = sorted({r.get("seasonId") for r in sc})
    if len(seasons) >= MIN_SEASONS_FOR_CI:
        rng = np.random.default_rng(rng_seed)
        by = {s: np.array([r["absError"] for r in sc if r.get("seasonId") == s]) for s in seasons}
        boots = []
        for _ in range(2000):
            pick = rng.choice(seasons, size=len(seasons), replace=True)
            boots.append(np.concatenate([by[s] for s in pick]).mean())
        out["maeCI90"] = [_r(np.quantile(boots, 0.05)), _r(np.quantile(boots, 0.95))]
        out["ciNote"] = f"season-block bootstrap over {len(seasons)} seasons, 2000 resamples"
    else:
        out["ciNote"] = f"no interval: {len(seasons)} scored season(s) < {MIN_SEASONS_FOR_CI} required for a season-block bootstrap"
    return out


def breakdown(records: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    groups: dict[Any, list] = {}
    for r in records:
        groups.setdefault(r.get(key), []).append(r)
    return [{"key": key, "value": k, **summarize(v)} for k, v in sorted(groups.items(), key=lambda kv: str(kv[0]))]


def target_key(r: dict[str, Any]) -> tuple:
    return (r.get("seasonId"), r["marketId"], r.get("productId"), r["targetWeek"])


def common_set(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Paired comparison on targets scored by every model that scored anything."""
    recs = list(records)
    models = sorted({r["modelId"] for r in recs})
    scored_by = {m: {target_key(r) for r in recs if r["modelId"] == m and r.get("scored")} for m in models}
    active = [m for m in models if scored_by[m]]
    excluded = [m for m in models if not scored_by[m]]
    keys = set.intersection(*(scored_by[m] for m in active)) if active else set()
    per = {m: summarize([r for r in recs if r["modelId"] == m and target_key(r) in keys]) for m in active}
    return {"nCommonTargets": len(keys), "modelsIncluded": active,
            "modelsExcludedNoScoredTargets": excluded, "perModel": per}
