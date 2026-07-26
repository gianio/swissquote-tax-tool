"""User-supplied configuration for building the eCH-0196 statement.

These are exactly the fields the web UI asks the user for.  Everything that
cannot be derived from the Swissquote CSV lives here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Dict, Optional

# Editable *approximate* year-end 2025 conversion rates to CHF.  They are only
# used to express foreign-currency income and tax values in CHF for the summary
# totals – the per-position detail is always kept in the original currency and
# the cantonal tax software recomputes CHF values from the official Kursliste.
DEFAULT_FX_RATES: Dict[str, Decimal] = {
    "CHF": Decimal("1"),
    "USD": Decimal("0.80"),
    "EUR": Decimal("0.93"),
    "CAD": Decimal("0.58"),
    "DKK": Decimal("0.125"),
    "GBP": Decimal("1.08"),
    "XAU": Decimal("3400"),   # ~ price of one ounce of gold in CHF
}

VALID_CANTONS = [
    "ZH", "BE", "LU", "UR", "SZ", "OW", "NW", "GL", "ZG", "FR", "SO", "BS",
    "BL", "SH", "AR", "AI", "SG", "GR", "AG", "TG", "TI", "VD", "VS", "NE",
    "GE", "JU",
]


@dataclass
class StatementConfig:
    """Everything the user provides to turn the CSV into a tax statement."""

    tax_year: int
    canton: str = "ZH"
    first_name: str = ""
    last_name: str = ""
    client_number: str = ""              # Swissquote account / client number
    depot_number: str = "1"
    institution_name: str = "Swissquote Bank AG"
    institution_lei: Optional[str] = None
    institution_clearing: str = "06435"  # Swissquote Bank Ltd BC/clearing number
    country: str = "CH"                  # taxpayer country of residence

    include_options: bool = True
    include_crypto: bool = True
    include_metals: bool = True

    fx_rates: Dict[str, Decimal] = field(default_factory=lambda: dict(DEFAULT_FX_RATES))

    @property
    def period_from(self) -> date:
        return date(self.tax_year, 1, 1)

    @property
    def period_to(self) -> date:
        return date(self.tax_year, 12, 31)

    def rate(self, currency: str) -> Decimal:
        return self.fx_rates.get(currency.upper(), Decimal("1"))
