"""
rachael_cu — Python-side handle to the @rachael/cu-core action/observation
schema. Re-exports the validators from packages/cu-core/src/python/schema.py
so the epic_agent command loop can validate the typed payloads it now
consumes from the control bus.
"""

import os
import sys

_SCHEMA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "packages", "cu-core", "src", "python")
)
if _SCHEMA_DIR not in sys.path:
    sys.path.insert(0, _SCHEMA_DIR)

from schema import (  # type: ignore  # noqa: E402
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
