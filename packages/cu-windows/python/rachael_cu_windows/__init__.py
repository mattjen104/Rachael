"""rachael-cu-windows — Python sidecar for @rachael/cu-windows.

Re-exports the SoM detector entry point and the schema validators so
external integrators have a single import path.
"""

from .schema import (
    ACTION_VERBS,
    LOCATOR_KINDS,
    OBSERVATION_KINDS,
    validate_action,
    validate_locator,
    validate_observation,
)

__all__ = [
    "ACTION_VERBS",
    "LOCATOR_KINDS",
    "OBSERVATION_KINDS",
    "validate_action",
    "validate_locator",
    "validate_observation",
]

__version__ = "0.1.0"
