"""ViolationStore protocol + the InMemoryViolationStore default.

V1 storage decision (per ADR-001):
  - Reeve owns its `contract_violations` table; Reeve uses its own
    asyncpg-backed adapter (lives in Reeve, not here).
  - Other consumers (Baton, Sentinel) wire their own store. covenant
    ships an in-memory store for tests and single-process consumers.
  - V2 (separate ADR-002): a covenant_main DB owns the table; consumers
    write through covenant's HTTP API.

The asyncpg-backed store class below is OPTIONAL and lives here as a
reference implementation that any consumer can copy or subclass. It
matches the schema Reeve uses today; see contract_violations.sql for
the migration. If asyncpg isn't installed, importing it raises a
clear error.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Optional, Protocol

from .types import Direction, Environment


class ViolationStore(Protocol):
    """Contract every store implements.

    `insert` records a violation; `count_recent` returns the count of
    violations matching (contract_id, environment) within the last
    `window_ms` milliseconds. Both are async to match the TS shape.
    """

    async def insert(
        self,
        *,
        contract_id: str,
        environment: Environment,
        direction: Direction,
        reason: str,
        tenant_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> None: ...

    async def count_recent(
        self,
        *,
        contract_id: str,
        environment: Environment,
        window_ms: int,
    ) -> int: ...


@dataclass
class _Row:
    contract_id: str
    environment: str
    direction: str
    reason: str
    tenant_id: Optional[str]
    correlation_id: Optional[str]
    observed_at_ms: float


class InMemoryViolationStore:
    """Process-local store. Useful for tests and single-process apps;
    not durable. Budgets reset on restart."""

    def __init__(self) -> None:
        self._rows: list[_Row] = []
        self._lock = asyncio.Lock()

    async def insert(
        self,
        *,
        contract_id: str,
        environment: Environment,
        direction: Direction,
        reason: str,
        tenant_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        async with self._lock:
            self._rows.append(
                _Row(
                    contract_id=contract_id,
                    environment=environment,
                    direction=direction,
                    reason=reason,
                    tenant_id=tenant_id,
                    correlation_id=correlation_id,
                    observed_at_ms=time.time() * 1000.0,
                )
            )

    async def count_recent(
        self,
        *,
        contract_id: str,
        environment: Environment,
        window_ms: int,
    ) -> int:
        async with self._lock:
            cutoff = time.time() * 1000.0 - window_ms
            return sum(
                1
                for r in self._rows
                if r.contract_id == contract_id
                and r.environment == environment
                and r.observed_at_ms > cutoff
            )

    # Test helpers — mirror the TS in-memory store's debug surface.
    def __test_clear(self) -> None:
        self._rows.clear()

    def __test_size(self) -> int:
        return len(self._rows)


class AsyncpgViolationStore:
    """Reference asyncpg-backed store. Matches Reeve's schema:

      CREATE TABLE contract_violations (
        id              bigserial PRIMARY KEY,
        contract_id     text NOT NULL,
        environment     text NOT NULL CHECK (environment IN ('dev','test','staging','prod')),
        direction       text NOT NULL CHECK (direction IN ('in','out')),
        reason          text NOT NULL,
        tenant_id       text,
        correlation_id  text,
        observed_at     timestamptz NOT NULL DEFAULT now()
      );

    Construct with an asyncpg pool; covenant doesn't manage the pool's
    lifecycle (the consumer owns it).
    """

    def __init__(self, pool: object, *, table: str = "contract_violations") -> None:
        self._pool = pool
        self._table = table

    async def insert(
        self,
        *,
        contract_id: str,
        environment: Environment,
        direction: Direction,
        reason: str,
        tenant_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        # Lazy-import asyncpg so the package imports cleanly without it.
        try:
            import asyncpg  # type: ignore[import-not-found]
        except ImportError as e:  # pragma: no cover
            raise ImportError(
                "covenant: AsyncpgViolationStore requires asyncpg. "
                "Install with `pip install covenant[asyncpg]`."
            ) from e
        del asyncpg  # type-only import; pool is the real handle.
        async with self._pool.acquire() as conn:  # type: ignore[attr-defined]
            await conn.execute(
                f"""INSERT INTO {self._table}
                    (contract_id, environment, direction, reason, tenant_id, correlation_id)
                    VALUES ($1, $2, $3, $4, $5, $6)""",
                contract_id,
                environment,
                direction,
                reason[:4000],
                tenant_id,
                correlation_id,
            )

    async def count_recent(
        self,
        *,
        contract_id: str,
        environment: Environment,
        window_ms: int,
    ) -> int:
        async with self._pool.acquire() as conn:  # type: ignore[attr-defined]
            row = await conn.fetchrow(
                f"""SELECT count(*) AS c
                      FROM {self._table}
                     WHERE contract_id = $1
                       AND environment = $2
                       AND observed_at > now() - ($3::int || ' milliseconds')::interval""",
                contract_id,
                environment,
                window_ms,
            )
            return int(row["c"]) if row else 0
