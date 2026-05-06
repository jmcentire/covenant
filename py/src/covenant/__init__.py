"""covenant — Python sibling of @stack/covenant.

Loads JSON Schema contracts from ~/Code/covenant/contracts/ (committed
artifacts produced by `covenant-export`) and validates payloads with
Pydantic v2.

Quickstart:

    from covenant import (
        Covenant,
        Environment,
        InMemoryViolationStore,
        load_contracts_from_dir,
    )

    cov = Covenant(store=InMemoryViolationStore())
    cov.load_contracts(load_contracts_from_dir("/path/to/contracts"))
    result = await cov.validate(
        contract_id="reeve.baton.event.shape",
        direction="in",
        value={"event_id": "...", ...},
    )
    if not result.ok:
        print(result.violation.reason)
"""

from .errors import (
    ContractAlreadyRegisteredError,
    ContractNotRegisteredError,
    CovenantError,
    ViolationStoreNotConfiguredError,
)
from .loader import load_contract_from_files, load_contracts_from_dir
from .runtime import Covenant, validate
from .store import InMemoryViolationStore, ViolationStore
from .types import (
    Contract,
    Environment,
    ValidationResult,
    Violation,
    ViolationAction,
    ViolationBudget,
    ViolationContext,
)

__all__ = [
    "Contract",
    "ContractAlreadyRegisteredError",
    "ContractNotRegisteredError",
    "Covenant",
    "CovenantError",
    "Environment",
    "InMemoryViolationStore",
    "ValidationResult",
    "Violation",
    "ViolationAction",
    "ViolationBudget",
    "ViolationContext",
    "ViolationStore",
    "ViolationStoreNotConfiguredError",
    "load_contract_from_files",
    "load_contracts_from_dir",
    "validate",
]
