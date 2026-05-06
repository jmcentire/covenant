"""Load contract artifacts emitted by the TS `covenant-export` CLI.

For each contract id we read two files:

  contracts/<id>.json           — JSON Schema (Draft 2020-12) wrapped in a
                                  covenant envelope: { contract_id, request, response }
  contracts/<id>.policy.yaml    — per-env policy + optional budget

The loader builds Pydantic v2 TypeAdapter validators from the JSON
Schemas via `jsonschema_rebuild`-style consumption. Pydantic doesn't
ship a generic "JSON Schema → BaseModel" yet, so we use `jsonschema`
for validation against the schema and surface the same shape of
validation errors the TS validator produces.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping

import yaml

from .errors import CovenantError
from .types import (
    Contract,
    Environment,
    OnExhaust,
    ViolationAction,
    ViolationBudget,
    _OnExhaustPageOperator,
    _OnExhaustPauseVendor,
    _OnExhaustRollback,
    _PerEnvPolicy,
)


def load_contract_from_files(schema_path: Path, policy_path: Path) -> Contract:
    """Load a single contract from a JSON Schema + policy YAML pair."""
    schema_doc = _read_json(schema_path)
    policy_doc = _read_yaml(policy_path)

    contract_id = schema_doc.get("contract_id")
    if not contract_id:
        raise CovenantError(
            f"covenant.loader: {schema_path} missing 'contract_id' (envelope field)"
        )
    policy_id = policy_doc.get("id")
    if policy_id != contract_id:
        raise CovenantError(
            f"covenant.loader: schema {schema_path} declares id={contract_id} "
            f"but policy {policy_path} declares id={policy_id}"
        )

    request_validator = _make_validator(schema_doc.get("request"))
    response_validator = _make_validator(schema_doc.get("response"))
    policy = _parse_policy(policy_doc.get("policy", {}))
    budget = _parse_budget(policy_doc.get("budget"))

    return Contract(
        id=contract_id,
        policy=policy,
        budget=budget,
        request_validator=request_validator,
        response_validator=response_validator,
    )


def load_contracts_from_dir(dir_path: str | Path) -> list[Contract]:
    """Load every (<id>.json, <id>.policy.yaml) pair under `dir_path`."""
    base = Path(dir_path)
    if not base.is_dir():
        raise CovenantError(f"covenant.loader: contracts dir not found: {base}")
    out: list[Contract] = []
    for schema_path in sorted(base.glob("*.json")):
        # Skip envelope-less files (would only matter if someone drops a
        # _common.schema.json — explicitly excluded).
        contract_id = schema_path.stem
        policy_path = base / f"{contract_id}.policy.yaml"
        if not policy_path.exists():
            raise CovenantError(
                f"covenant.loader: schema {schema_path} has no companion policy file "
                f"at {policy_path}"
            )
        out.append(load_contract_from_files(schema_path, policy_path))
    return out


# ----- helpers --------------------------------------------------------------


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise CovenantError(f"covenant.loader: file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise CovenantError(f"covenant.loader: file not found: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _make_validator(schema: Any) -> Any:
    """Build a runtime validator object from a JSON Schema fragment.

    We deliberately don't use Pydantic's BaseModel here — the JSON
    Schema arrives at runtime, so we need a generic validator that
    closes over the schema dict. `jsonschema` provides exactly that:
    Validator instances cache their compiled state and produce path-
    annotated error iterators we can shape like Zod issues.
    """
    if not schema:
        return None
    # Lazy import so the package is usable without jsonschema for
    # consumers that ship their own validation harness.
    try:
        from jsonschema import Draft202012Validator  # type: ignore[import-not-found]
    except ImportError as e:  # pragma: no cover - environment misconfig
        raise CovenantError(
            "covenant.loader: jsonschema is required to consume JSON Schema contracts. "
            "Install with `pip install jsonschema`."
        ) from e
    return Draft202012Validator(schema)


def _parse_policy(raw: Mapping[str, Any]) -> Mapping[Environment, _PerEnvPolicy]:
    out: dict[Environment, _PerEnvPolicy] = {}
    expected: tuple[Environment, ...] = ("dev", "test", "staging", "prod")
    for env in expected:
        if env not in raw:
            raise CovenantError(
                f"covenant.loader: policy missing required env '{env}' "
                f"(every contract must declare policy in every env)"
            )
        env_policy = raw[env]
        in_action = _validate_action(env_policy.get("in"), env, "in")
        out_action = _validate_action(env_policy.get("out"), env, "out")
        out[env] = _PerEnvPolicy(in_=in_action, out=out_action)
    return out


_VALID_ACTIONS: tuple[ViolationAction, ...] = ("log-only", "log-and-emit", "strict-reject")


def _validate_action(value: Any, env: str, direction: str) -> ViolationAction:
    if value not in _VALID_ACTIONS:
        raise CovenantError(
            f"covenant.loader: policy.{env}.{direction} must be one of "
            f"{_VALID_ACTIONS}, got {value!r}"
        )
    return value  # type: ignore[return-value]


def _parse_budget(raw: Any) -> ViolationBudget | None:
    if raw is None:
        return None
    window_ms = raw.get("windowMs")
    max_violations = raw.get("maxViolations")
    on_exhaust_raw = raw.get("onExhaust", {})
    if not isinstance(window_ms, int) or window_ms <= 0:
        raise CovenantError(
            f"covenant.loader: budget.windowMs must be a positive integer, got {window_ms!r}"
        )
    if not isinstance(max_violations, int) or max_violations < 0:
        raise CovenantError(
            f"covenant.loader: budget.maxViolations must be a non-negative integer, "
            f"got {max_violations!r}"
        )
    kind = on_exhaust_raw.get("kind") if isinstance(on_exhaust_raw, dict) else None
    on_exhaust: OnExhaust
    if kind == "rollback":
        on_exhaust = _OnExhaustRollback()
    elif kind == "pause-vendor":
        on_exhaust = _OnExhaustPauseVendor()
    elif kind == "page-operator":
        on_exhaust = _OnExhaustPageOperator()
    else:
        raise CovenantError(
            "covenant.loader: budget.onExhaust.kind must be one of "
            f"['rollback', 'pause-vendor', 'page-operator'], got {kind!r}"
        )
    return ViolationBudget(
        windowMs=window_ms,
        maxViolations=max_violations,
        onExhaust=on_exhaust,
    )


# Allow callers to update an already-built contract (e.g., to swap in a
# Pydantic model wrapper). Keeps Contract immutable from the outside.
def replace_contract(c: Contract, **kwargs: Any) -> Contract:
    return replace(c, **kwargs)
