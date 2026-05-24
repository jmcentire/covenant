"""Core types matching covenant's TS public API.

The TS canonical types (in ts/src/types.ts) are the source of truth.
These Python mirrors stay in lock-step; deviations are bugs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Optional, Union

# Per-env policy + budget shape.
Environment = Literal["dev", "test", "staging", "prod"]
ViolationAction = Literal["log-only", "log-and-emit", "strict-reject"]
Direction = Literal["in", "out"]


@dataclass(frozen=True)
class _OnExhaustRollback:
    kind: Literal["rollback"] = "rollback"


@dataclass(frozen=True)
class _OnExhaustPauseVendor:
    kind: Literal["pause-vendor"] = "pause-vendor"


@dataclass(frozen=True)
class _OnExhaustPageOperator:
    kind: Literal["page-operator"] = "page-operator"


OnExhaust = Union[_OnExhaustRollback, _OnExhaustPauseVendor, _OnExhaustPageOperator]


@dataclass(frozen=True)
class ViolationBudget:
    windowMs: int
    maxViolations: int
    onExhaust: OnExhaust


@dataclass(frozen=True)
class _PerEnvPolicy:
    in_: ViolationAction
    out: ViolationAction


@dataclass(frozen=True)
class Contract:
    """Runtime contract record. The Pydantic-built validators are
    attached after loader resolves the JSON Schema."""

    id: str
    policy: Mapping[Environment, _PerEnvPolicy]
    budget: Optional[ViolationBudget] = None
    # Pydantic v2 type adapters built from JSON Schema. None = no
    # schema declared for that direction (passthrough).
    request_validator: Any = field(default=None, repr=False)
    response_validator: Any = field(default=None, repr=False)


@dataclass(frozen=True)
class ViolationContext:
    tenant_id: Optional[str] = None
    correlation_id: Optional[str] = None


@dataclass(frozen=True)
class Violation:
    contract_id: str
    direction: Direction
    reason: str
    action: ViolationAction
    budget_exhausted: bool
    env: Environment


@dataclass(frozen=True)
class ValidationResult:
    """Either ok=True with `value`, or ok=False with `violation`. Mirrors
    the TS discriminated-union shape; .ok is the discriminator."""

    ok: bool
    value: Any = None
    violation: Optional[Violation] = None
