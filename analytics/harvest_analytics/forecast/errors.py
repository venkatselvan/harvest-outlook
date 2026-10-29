"""Exception types. LeakageError carries the offending rows so callers can audit them."""

from __future__ import annotations

from typing import Any


class ForecastError(Exception):
    """Base class for forecasting errors."""


class ContractError(ForecastError):
    """Input does not satisfy the documented data or request contract."""


class LeakageError(ForecastError):
    """A row whose availableAt is after the decision cutoff reached a feature, label or transform."""

    def __init__(self, message: str, rows: list[dict[str, Any]]):
        super().__init__(f"{message}; offending rows (first 10): {rows[:10]}")
        self.rows = rows


class FreezeViolation(ForecastError):
    """Predictions changed after freeze(), or realized values were requested without a valid freeze."""
