"""Python sibling tests — port of ts/tests/covenant.test.ts.

We exercise the runtime against the canonical baton-event JSON Schema
that `covenant-export` emits. This lets us prove that the JSON Schema
artifact (Zod source of truth → committed JSON Schema) is consumable
verbatim by the Pydantic-side runtime.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from covenant import (
    ContractAlreadyRegisteredError,
    ContractNotRegisteredError,
    Covenant,
    InMemoryViolationStore,
    ValidationResult,
    load_contract_from_files,
)
from covenant.types import Contract, _PerEnvPolicy, ViolationBudget, _OnExhaustPageOperator
from jsonschema import Draft202012Validator


REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = REPO_ROOT / "contracts"


# ----- helpers --------------------------------------------------------------


def _foo_contract() -> Contract:
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "minLength": 1},
            "count": {"type": "integer", "minimum": 0},
        },
        "required": ["name", "count"],
        "additionalProperties": False,
    }
    return Contract(
        id="test.foo",
        policy={
            "dev": _PerEnvPolicy(in_="strict-reject", out="log-only"),
            "test": _PerEnvPolicy(in_="strict-reject", out="log-only"),
            "staging": _PerEnvPolicy(in_="log-and-emit", out="log-only"),
            "prod": _PerEnvPolicy(in_="log-only", out="log-only"),
        },
        request_validator=Draft202012Validator(schema),
    )


@pytest.fixture
def cov() -> Covenant:
    c = Covenant(store=InMemoryViolationStore(), env="test")
    return c


# ----- ported tests ---------------------------------------------------------


def test_register_refuses_duplicate(cov: Covenant) -> None:
    cov.register(_foo_contract())
    with pytest.raises(ContractAlreadyRegisteredError):
        cov.register(_foo_contract())


@pytest.mark.asyncio
async def test_validate_unknown_contract_throws(cov: Covenant) -> None:
    with pytest.raises(ContractNotRegisteredError):
        await cov.validate(contract_id="never.registered", direction="in", value={})


@pytest.mark.asyncio
async def test_validate_happy_path(cov: Covenant) -> None:
    cov.register(_foo_contract())
    r = await cov.validate(
        contract_id="test.foo",
        direction="in",
        value={"name": "hello", "count": 3},
    )
    assert r.ok is True
    assert r.value == {"name": "hello", "count": 3}


@pytest.mark.asyncio
async def test_validate_violation_returns_structured(cov: Covenant) -> None:
    cov.register(_foo_contract())
    r = await cov.validate(
        contract_id="test.foo",
        direction="in",
        value={"name": "", "count": -1},
    )
    assert r.ok is False
    assert r.violation is not None
    assert r.violation.contract_id == "test.foo"
    assert r.violation.direction == "in"
    assert r.violation.action == "strict-reject"
    assert r.violation.budget_exhausted is False
    assert "name" in r.violation.reason


@pytest.mark.asyncio
async def test_per_env_policy_switches_action(cov: Covenant) -> None:
    cov.register(_foo_contract())
    r_test = await cov.validate(
        contract_id="test.foo",
        direction="in",
        value={"wrong": True},
        env="test",
    )
    assert r_test.ok is False
    assert r_test.violation is not None
    assert r_test.violation.action == "strict-reject"

    r_prod = await cov.validate(
        contract_id="test.foo",
        direction="in",
        value={"wrong": True},
        env="prod",
    )
    assert r_prod.ok is False
    assert r_prod.violation is not None
    assert r_prod.violation.action == "log-only"


@pytest.mark.asyncio
async def test_violation_persists_to_store(cov: Covenant) -> None:
    cov.register(_foo_contract())
    await cov.validate(
        contract_id="test.foo",
        direction="in",
        value={"wrong": True},
    )
    store = cov._store  # type: ignore[attr-defined]
    assert isinstance(store, InMemoryViolationStore)
    c = await store.count_recent(
        contract_id="test.foo",
        environment="test",
        window_ms=60_000,
    )
    assert c == 1


@pytest.mark.asyncio
async def test_budget_exhaustion(cov: Covenant) -> None:
    schema = {
        "type": "object",
        "properties": {"ok": {"const": True}},
        "required": ["ok"],
        "additionalProperties": False,
    }
    cov.register(
        Contract(
            id="test.budget",
            policy={
                "dev": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "test": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "staging": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "prod": _PerEnvPolicy(in_="strict-reject", out="log-only"),
            },
            budget=ViolationBudget(
                windowMs=60_000,
                maxViolations=3,
                onExhaust=_OnExhaustPageOperator(),
            ),
            request_validator=Draft202012Validator(schema),
        )
    )

    for _ in range(3):
        r = await cov.validate(
            contract_id="test.budget", direction="in", value={"wrong": True}
        )
        assert r.ok is False
        assert r.violation is not None
        assert r.violation.budget_exhausted is False

    r4 = await cov.validate(
        contract_id="test.budget", direction="in", value={"wrong": True}
    )
    assert r4.ok is False
    assert r4.violation is not None
    assert r4.violation.budget_exhausted is True


@pytest.mark.asyncio
async def test_independent_env_budgets(cov: Covenant) -> None:
    schema = {
        "type": "object",
        "properties": {"ok": {"const": True}},
        "required": ["ok"],
        "additionalProperties": False,
    }
    cov.register(
        Contract(
            id="test.env-budget",
            policy={
                "dev": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "test": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "staging": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "prod": _PerEnvPolicy(in_="strict-reject", out="log-only"),
            },
            budget=ViolationBudget(
                windowMs=60_000, maxViolations=1, onExhaust=_OnExhaustPageOperator()
            ),
            request_validator=Draft202012Validator(schema),
        )
    )

    await cov.validate(
        contract_id="test.env-budget",
        direction="in",
        value={"wrong": True},
        env="test",
    )
    r_test_2 = await cov.validate(
        contract_id="test.env-budget",
        direction="in",
        value={"wrong": True},
        env="test",
    )
    assert r_test_2.violation is not None
    assert r_test_2.violation.budget_exhausted is True

    r_prod_1 = await cov.validate(
        contract_id="test.env-budget",
        direction="in",
        value={"wrong": True},
        env="prod",
    )
    assert r_prod_1.violation is not None
    assert r_prod_1.violation.budget_exhausted is False


@pytest.mark.asyncio
async def test_no_response_schema_passes(cov: Covenant) -> None:
    cov.register(
        Contract(
            id="test.no-response-schema",
            policy={
                "dev": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "test": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "staging": _PerEnvPolicy(in_="strict-reject", out="log-only"),
                "prod": _PerEnvPolicy(in_="strict-reject", out="log-only"),
            },
            request_validator=Draft202012Validator(
                {
                    "type": "object",
                    "properties": {"x": {"type": "number"}},
                    "required": ["x"],
                }
            ),
            response_validator=None,
        )
    )
    r = await cov.validate(
        contract_id="test.no-response-schema",
        direction="out",
        value="whatever",
    )
    assert r.ok is True


# ----- consume the canonical Baton-event contract via the JSON Schema ------


@pytest.mark.asyncio
async def test_loader_round_trip_baton_event() -> None:
    """The TS-emitted JSON Schema for the baton-event contract is
    consumable verbatim by the Python loader; identical-shape payloads
    pass."""
    schema_path = CONTRACTS_DIR / "reeve.baton.event.shape.json"
    policy_path = CONTRACTS_DIR / "reeve.baton.event.shape.policy.yaml"
    assert schema_path.exists(), f"missing canonical artifact: {schema_path}"

    contract = load_contract_from_files(schema_path, policy_path)
    cov = Covenant(store=InMemoryViolationStore(), env="prod")
    cov.register(contract)

    valid = {
        "event_id": "01234567-89ab-4def-8123-456789abcdef",
        "schema_version": 1,
        "event_type": "reeve.action.shipped",
        "occurred_at": "2026-05-06T12:34:56Z",
        "payload": {"foo": "bar"},
    }
    r = await cov.validate(
        contract_id="reeve.baton.event.shape", direction="in", value=valid
    )
    assert r.ok is True

    invalid = {**valid, "event_type": "BadType"}  # uppercase fails the regex
    r2 = await cov.validate(
        contract_id="reeve.baton.event.shape", direction="in", value=invalid
    )
    assert r2.ok is False
    assert r2.violation is not None
    assert "event_type" in r2.violation.reason
