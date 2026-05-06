"""Run vectors/policy-cases.json against the Python runtime. Mirrors
ts/tests/golden-vectors.test.ts; both impls must agree."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from covenant import Covenant, InMemoryViolationStore
from covenant.types import (
    Contract,
    OnExhaust,
    ViolationBudget,
    _OnExhaustPageOperator,
    _OnExhaustPauseVendor,
    _OnExhaustRollback,
    _PerEnvPolicy,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
VECTORS_PATH = REPO_ROOT / "vectors" / "policy-cases.json"


def _on_exhaust(kind: str) -> OnExhaust:
    if kind == "rollback":
        return _OnExhaustRollback()
    if kind == "pause-vendor":
        return _OnExhaustPauseVendor()
    if kind == "page-operator":
        return _OnExhaustPageOperator()
    raise ValueError(f"unknown onExhaust kind: {kind}")


def _build_contract(spec: dict) -> Contract:
    policy_raw = spec["policy"]
    policy = {
        env: _PerEnvPolicy(in_=policy_raw[env]["in"], out=policy_raw[env]["out"])
        for env in ("dev", "test", "staging", "prod")
    }
    budget = None
    if "budget" in spec:
        b = spec["budget"]
        budget = ViolationBudget(
            windowMs=b["windowMs"],
            maxViolations=b["maxViolations"],
            onExhaust=_on_exhaust(b["onExhaust"]["kind"]),
        )
    return Contract(
        id=spec["id"],
        policy=policy,
        budget=budget,
        request_validator=Draft202012Validator(spec["schema"]),
        response_validator=None,
    )


@pytest.mark.asyncio
async def test_golden_vectors_pass() -> None:
    data = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
    cov = Covenant(store=InMemoryViolationStore())
    for spec in data["contracts"]:
        cov.register(_build_contract(spec))

    for case in data["cases"]:
        r = await cov.validate(
            contract_id=case["contractId"],
            direction=case["direction"],
            value=case["value"],
            env=case["env"],
        )
        expect = case["expect"]
        if expect["ok"]:
            assert r.ok is True, f"{case['name']}: expected ok=True, got {r}"
        else:
            assert r.ok is False, f"{case['name']}: expected ok=False, got ok=True"
            assert r.violation is not None
            assert r.violation.action == expect["action"], (
                f"{case['name']}: action mismatch — "
                f"got {r.violation.action}, expected {expect['action']}"
            )
            assert r.violation.budget_exhausted == expect["budgetExhausted"], (
                f"{case['name']}: budgetExhausted mismatch — "
                f"got {r.violation.budget_exhausted}, "
                f"expected {expect['budgetExhausted']}"
            )
