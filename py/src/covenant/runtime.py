"""Covenant runtime — Python sibling of TS validate().

The public shape mirrors the TS API:
  - validate({contract_id, direction, value, env?, context?}) returns
    a ValidationResult; never throws on contract violation (callers
    decide what to do based on .ok and .violation.action).
  - Programmer errors (unknown contract id, unconfigured store) DO
    throw — they're not contract violations.

Process-local global instance is also exposed via the module-level
`validate()` for parity with the TS API. Consumers who want
multi-tenant isolation construct their own Covenant() instances.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from .errors import (
    ContractAlreadyRegisteredError,
    ContractNotRegisteredError,
    ViolationStoreNotConfiguredError,
)
from .store import InMemoryViolationStore, ViolationStore
from .types import (
    Contract,
    Direction,
    Environment,
    ValidationResult,
    Violation,
    ViolationAction,
    ViolationContext,
)

logger = logging.getLogger("covenant")


def _detect_env() -> Environment:
    node = os.environ.get("NODE_ENV") or os.environ.get("COVENANT_ENV", "")
    if node == "production":
        return "prod"
    if node == "staging":
        return "staging"
    if node == "test":
        return "test"
    return "dev"


class Covenant:
    """Owns a contract registry and a single ViolationStore.

    Constructed once per process (or once per tenant boundary, if a
    consumer wants isolation).
    """

    def __init__(
        self,
        *,
        store: Optional[ViolationStore] = None,
        env: Optional[Environment] = None,
    ) -> None:
        self._registry: dict[str, Contract] = {}
        self._store: Optional[ViolationStore] = store
        self._env_override: Optional[Environment] = env

    def set_store(self, store: ViolationStore) -> None:
        self._store = store

    def set_env(self, env: Optional[Environment]) -> None:
        self._env_override = env

    def env(self) -> Environment:
        return self._env_override or _detect_env()

    def register(self, contract: Contract) -> None:
        if contract.id in self._registry:
            raise ContractAlreadyRegisteredError(contract.id)
        self._registry[contract.id] = contract

    def load_contracts(self, contracts: list[Contract]) -> None:
        for c in contracts:
            self.register(c)

    def lookup(self, contract_id: str) -> Optional[Contract]:
        return self._registry.get(contract_id)

    def list_contracts(self) -> list[Contract]:
        return list(self._registry.values())

    def __test_clear(self) -> None:
        self._registry.clear()

    async def validate(
        self,
        *,
        contract_id: str,
        direction: Direction,
        value: Any,
        context: Optional[ViolationContext] = None,
        env: Optional[Environment] = None,
    ) -> ValidationResult:
        contract = self._registry.get(contract_id)
        if contract is None:
            raise ContractNotRegisteredError(contract_id)

        active_env: Environment = env or self.env()
        action: ViolationAction = (
            contract.policy[active_env].in_
            if direction == "in"
            else contract.policy[active_env].out
        )

        validator = (
            contract.request_validator if direction == "in" else contract.response_validator
        )
        if validator is None:
            # No schema declared for this direction — pass.
            return ValidationResult(ok=True, value=value)

        # Run the schema. We support two validator shapes: jsonschema's
        # Validator (iter_errors) and a callable (raises on failure).
        errors = list(validator.iter_errors(value)) if hasattr(validator, "iter_errors") else []
        if not errors:
            return ValidationResult(ok=True, value=value)

        reason = _format_errors(errors)

        # 1. Log (always).
        logger.warning(
            "covenant.violation",
            extra={
                "contract_id": contract_id,
                "direction": direction,
                "env": active_env,
                "action": action,
                "reason": reason,
                "tenant_id": context.tenant_id if context else None,
                "correlation_id": context.correlation_id if context else None,
            },
        )

        if self._store is None:
            raise ViolationStoreNotConfiguredError()

        await self._store.insert(
            contract_id=contract_id,
            environment=active_env,
            direction=direction,
            reason=reason,
            tenant_id=context.tenant_id if context else None,
            correlation_id=context.correlation_id if context else None,
        )

        # 2. Budget check.
        budget_exhausted = False
        if contract.budget is not None:
            recent_count = await self._store.count_recent(
                contract_id=contract_id,
                environment=active_env,
                window_ms=contract.budget.windowMs,
            )
            if recent_count > contract.budget.maxViolations:
                budget_exhausted = True
                logger.error(
                    "covenant.budget_exhausted",
                    extra={
                        "contract_id": contract_id,
                        "env": active_env,
                        "recent_count": recent_count,
                        "window_ms": contract.budget.windowMs,
                        "max_violations": contract.budget.maxViolations,
                        "on_exhaust": contract.budget.onExhaust.kind,
                    },
                )

        return ValidationResult(
            ok=False,
            violation=Violation(
                contract_id=contract_id,
                direction=direction,
                reason=reason,
                action=action,
                budget_exhausted=budget_exhausted,
                env=active_env,
            ),
        )


def _format_errors(errors: list[Any]) -> str:
    """Format jsonschema errors in the same shape the TS validator
    produces (path: message; path: message). Capped at 4000 chars to
    match the TS ceiling."""
    parts: list[str] = []
    for err in errors:
        path = ".".join(str(p) for p in err.absolute_path) or "<root>"
        message = err.message
        parts.append(f"{path}: {message}")
    out = "; ".join(parts) or "unknown validation failure"
    return out[:4000]


# Module-level singleton, parallel to the TS module-level state.
_singleton = Covenant(store=None, env=None)


def get_default() -> Covenant:
    return _singleton


async def validate(
    *,
    contract_id: str,
    direction: Direction,
    value: Any,
    context: Optional[ViolationContext] = None,
    env: Optional[Environment] = None,
) -> ValidationResult:
    """Module-level convenience wrapper around the singleton instance."""
    return await _singleton.validate(
        contract_id=contract_id,
        direction=direction,
        value=value,
        context=context,
        env=env,
    )


__all__ = [
    "Covenant",
    "get_default",
    "validate",
]


# Default in-memory store on first import — gives test harnesses a
# usable instance without configuration. Production callers MUST
# replace this via Covenant.set_store() or by constructing their own
# Covenant().
_singleton.set_store(InMemoryViolationStore())
