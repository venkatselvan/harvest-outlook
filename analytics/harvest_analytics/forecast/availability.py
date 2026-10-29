"""As-of snapshots and the availability guard.

Every table that reaches feature construction, label construction, climatology or calibration is
wrapped in an AvailableView. Constructing a view re-checks `availableAt <= cutoff` row by row and
raises LeakageError with the offending rows on any violation, so a code path that forgets to filter
fails loudly instead of leaking.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from .errors import LeakageError

MAX_EXAMPLES = 10


class ExclusionLog:
    """Counts excluded rows by reason with a few example rowIds; denominators kept explicit."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.examples: dict[str, list[str]] = {}

    def add(self, reason: str, row_ids: list[str] | pd.Series) -> None:
        ids = [str(x) for x in list(row_ids)]
        if not ids:
            return
        self.counts[reason] = self.counts.get(reason, 0) + len(ids)
        ex = self.examples.setdefault(reason, [])
        ex.extend(ids[: max(0, MAX_EXAMPLES - len(ex))])

    def merge(self, other: "ExclusionLog", prefix: str = "") -> None:
        for reason, n in other.counts.items():
            key = prefix + reason
            self.counts[key] = self.counts.get(key, 0) + n
            ex = self.examples.setdefault(key, [])
            ex.extend(other.examples.get(reason, [])[: max(0, MAX_EXAMPLES - len(ex))])

    def to_dict(self) -> dict[str, Any]:
        return {"counts": dict(sorted(self.counts.items())), "examples": dict(sorted(self.examples.items()))}


def to_utc(ts: str | pd.Timestamp) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        raise ValueError("cutoff timestamps must carry a timezone offset")
    return t.tz_convert("UTC")


def assert_available(frame: pd.DataFrame, cutoff: pd.Timestamp, kind: str) -> None:
    late = frame[frame["availableAt"] > cutoff]
    if len(late):
        rows = [
            {"rowId": str(r.rowId), "availableAt": r.availableAt.isoformat()}
            for r in late[["rowId", "availableAt"]].itertuples(index=False)
        ]
        raise LeakageError(f"{len(late)} {kind} row(s) have availableAt after decisionCutoff {cutoff.isoformat()}", rows)


@dataclass(eq=False)
class AvailableView:
    """A table certified to contain only rows available at `cutoff`. Validation runs on construction."""

    frame: pd.DataFrame
    cutoff: pd.Timestamp
    kind: str
    exclusions: ExclusionLog = field(default_factory=ExclusionLog)

    def __post_init__(self) -> None:
        assert_available(self.frame, self.cutoff, self.kind)

    @property
    def max_available_at(self) -> pd.Timestamp | None:
        return None if self.frame.empty else self.frame["availableAt"].max()


def _lineage_roots(df: pd.DataFrame) -> pd.Series:
    parent = dict(zip(df["rowId"], df["revisionOf"]))
    roots = {}
    for rid in df["rowId"]:
        seen = set()
        cur = rid
        while parent.get(cur) is not None:
            if cur in seen:
                raise ValueError(f"revision cycle at {rid}")
            seen.add(cur)
            cur = parent[cur]
        roots[rid] = cur
    return df["rowId"].map(roots)


def snapshot_as_of(frame: pd.DataFrame, cutoff: pd.Timestamp | None, *, kind: str, date_col: str,
                   strict_vintage: bool = True) -> AvailableView:
    """Resolve the table as it was knowable at `cutoff` (None = latest revision of everything).

    Per lineage (original row plus its revisions), keep the latest version with availableAt <= cutoff.
    A revision published after the cutoff is excluded and the earlier version is used.
    """
    log = ExclusionLog()
    df = frame.copy()
    df["_root"] = _lineage_roots(df) if len(df) else pd.Series(dtype=object)
    effective_cutoff = cutoff if cutoff is not None else (df["availableAt"].max() if len(df) else pd.Timestamp.now(tz="UTC"))

    if strict_vintage:
        est = df["availableAtBasis"] == "estimated"
        log.add("unverifiable_vintage", df.loc[est, "rowId"])
        df = df[~est]

    # availableAt earlier than one day before the observation/period end is not a credible vintage.
    obs_day = df[date_col].dt.tz_localize("UTC")
    bogus = df["availableAt"] < (obs_day - pd.Timedelta(days=1))
    log.add("available_before_observed", df.loc[bogus, "rowId"])
    df = df[~bogus]

    late = df["availableAt"] > effective_cutoff
    if late.any():
        lr = df[late]
        is_rev = lr["revisionOf"].notna()
        cutoff_day = effective_cutoff.tz_convert("UTC").tz_localize(None).normalize()
        observed_before = lr[date_col] <= cutoff_day
        log.add("revision_not_yet_available", lr.loc[is_rev, "rowId"])
        log.add("published_after_cutoff", lr.loc[~is_rev & observed_before, "rowId"])
        log.add("observed_after_cutoff", lr.loc[~is_rev & ~observed_before, "rowId"])
    df = df[~late]

    if len(df):
        df = df.assign(_order=range(len(df))).sort_values(["_root", "availableAt", "_order"])
        superseded = df.duplicated("_root", keep="last")
        log.add("superseded_by_revision", df.loc[superseded, "rowId"])
        df = df[~superseded].sort_values("_order").drop(columns=["_order"])
    df = df.drop(columns=["_root"]).reset_index(drop=True)
    return AvailableView(frame=df, cutoff=effective_cutoff, kind=kind, exclusions=log)
