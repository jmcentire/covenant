"""covenant runtime errors. Mirror the TS errors module."""


class CovenantError(Exception):
    """Base exception for the covenant runtime."""


class ContractAlreadyRegisteredError(CovenantError):
    def __init__(self, contract_id: str) -> None:
        super().__init__(
            f"covenant: contract id={contract_id} already registered. "
            "Each id registers exactly once."
        )
        self.contract_id = contract_id


class ContractNotRegisteredError(CovenantError):
    def __init__(self, contract_id: str) -> None:
        super().__init__(
            f"covenant: contract id={contract_id} not registered. "
            "Call Covenant.load_contracts(...) first."
        )
        self.contract_id = contract_id


class ViolationStoreNotConfiguredError(CovenantError):
    def __init__(self) -> None:
        super().__init__(
            "covenant: violation store not configured. Pass `store=` to Covenant() "
            "before validate()."
        )
