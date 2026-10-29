"""Leakage-safe price forecasting replay: baselines, candidate model, metrics and ablations.

All numerical outputs come from code in this package. No LLM-authored numbers enter any path.
See docs/FORECASTING.md for the data contract, target definition and replay rules.
"""

from .errors import ContractError, ForecastError, FreezeViolation, LeakageError

__all__ = ["ContractError", "ForecastError", "FreezeViolation", "LeakageError"]
