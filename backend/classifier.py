"""Classify Swissquote transactions and reconstruct year-end positions.

The Swissquote export mixes securities trades, income, cash movements, fees and
corporate actions in a single flat list.  For an eCH-0196 e-Steuerauszug we only
care about a subset of these.  This module groups the raw transactions into
instruments (one per security) and side lists (cash interest, fees, ignored cash
movements) and reconstructs the running quantity per instrument – inferring an
opening balance whenever the year contains a sale of shares that were already
held before the tax period.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Dict, List, Optional

from .csv_parser import Transaction

# --- Transaction-type buckets ------------------------------------------------
# German labels exactly as they appear in the Swissquote export.

BUY_TYPES = {"Kauf", "Buy-to-Open"}
SELL_TYPES = {"Verkauf"}
INCOME_TYPES = {"Dividende", "Capital Gain"}
CASH_INTEREST_TYPES = {"Zinsen auf Einlagen"}
FEE_TYPES = {"Depotgebühren"}
FEE_CORRECTION_TYPES = {"Berichtigung Börsengeb."}
# Corporate actions that change a position without a cash trade.
CORPORATE_ACTION_TYPES = {
    "Titelumbuchung",          # reclassification (e.g. rights -> shares)
    "Ausübung von Anrechten",  # exercise of subscription rights
    "Ausgabe von Anrechten",   # issue of subscription rights
    "Ausübung",                # option exercise / assignment
    "Expiration",              # option expiry (position goes to zero)
    "Rückzahlung",             # redemption / repayment
}
# Pure cash-account movements – never part of a securities statement.
CASH_MOVEMENT_TYPES = {
    "Kartentransaktion",       # debit-card spending
    "Fx-Gutschrift Comp.", "Fx-Belastung Comp.",   # auto FX for card spending
    "Forex-Gutschrift", "Forex-Belastung",         # manual FX / metal trades
    "Zahlung",                 # cash deposit / transfer in
}

# Instruments whose ISIN column is a Swissquote-internal pseudo identifier
# rather than a real ISIN (crypto currencies, listed options / warrants).
_CRYPTO_ISIN_RE = re.compile(r"^EX0X00")
_OPTION_ISIN_RE = re.compile(r"^(SQ|XB)")
_REAL_ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")

# Map a currency to a plausible country when the instrument has no real ISIN.
CURRENCY_COUNTRY = {
    "CHF": "CH",
    "USD": "US",
    "CAD": "CA",
    "DKK": "DK",
    "XAU": "XX",
}


@dataclass
class Movement:
    """A single quantity movement (trade or corporate action) for a security."""

    date: date
    type: str
    quantity: Decimal          # signed: + for additions, - for disposals
    unit_price: Optional[Decimal]
    gross_amount: Optional[Decimal]   # abs(net) + costs, in instrument currency
    costs: Optional[Decimal]
    currency: str
    order_number: str
    is_addition: bool
    source_row: int


@dataclass
class Income:
    """A dividend / distribution / interest payment for a security."""

    date: date
    type: str
    gross: Decimal             # gross income in instrument currency
    tax: Decimal               # withholding tax withheld at source (costs column)
    net: Decimal
    currency: str
    source_row: int


@dataclass
class Instrument:
    """All movements and income for one security across the tax year."""

    key: str
    symbol: str
    name: str
    isin: Optional[str]
    currency: str
    country: str
    category: str              # eCH SecurityCategory literal
    security_type: Optional[str] = None
    movements: List[Movement] = field(default_factory=list)
    income: List[Income] = field(default_factory=list)
    corporate_actions: List[Movement] = field(default_factory=list)

    # Reconstructed quantities (filled in by reconstruct_positions()).
    opening_quantity: Decimal = Decimal(0)
    closing_quantity: Decimal = Decimal(0)
    opening_inferred: bool = False

    @property
    def is_crypto(self) -> bool:
        return self.category == "OTHER" and self.security_type == "crypto"

    @property
    def is_option(self) -> bool:
        return self.category == "OPTION"


@dataclass
class ClassificationResult:
    instruments: List[Instrument]
    cash_interest: List[Income]
    fees: List[Movement]
    ignored_cash: List[Transaction]
    metals: List[Transaction]         # XAU / precious-metal forex legs
    warnings: List[str] = field(default_factory=list)


def _gross_from(t: Transaction) -> Optional[Decimal]:
    """Gross amount in the instrument currency = |net| + costs.

    Swissquote reports ``Nettobetrag`` net of fees/withholding, and the fee or
    withholding tax separately in ``Kosten``.  For income the gross dividend is
    therefore ``net + costs``; for trades the gross traded value is the same.
    """
    if t.net_amount is None:
        # Fall back to quantity * unit price when the net column is blank.
        if t.quantity is not None and t.unit_price is not None:
            return abs(t.quantity * t.unit_price)
        return None
    costs = t.costs or Decimal(0)
    return abs(t.net_amount) + costs


def _classify_instrument(t: Transaction) -> tuple[Optional[str], str, str]:
    """Return (isin_or_none, category, security_type_hint) for a security row."""
    isin = t.isin.strip()
    if _CRYPTO_ISIN_RE.match(isin):
        return None, "OTHER", "crypto"
    if _OPTION_ISIN_RE.match(isin):
        # Swissquote-internal option / warrant identifiers (SQ…, XB…).
        return None, "OPTION", "option"
    if _REAL_ISIN_RE.match(isin):
        # Funds/ETFs vs shares: a broad-brush guess from the name.
        name = t.name.upper()
        if any(tok in name for tok in ("ETF", "FUND", "UCITS", "ISH", "UBSETF", "VANGUARD", "ISHARES")):
            return isin, "FUND", None
        return isin, "SHARE", None
    # No usable identifier – treat as a generic "other" position.
    return None, "OTHER", None


def _instrument_key(t: Transaction, isin: Optional[str]) -> str:
    if isin:
        return f"isin:{isin}"
    if t.symbol:
        return f"sym:{t.symbol}"
    return f"name:{t.name}"


def classify(transactions: List[Transaction], default_country: str = "CH") -> ClassificationResult:
    """Group transactions into instruments and side lists."""
    instruments: Dict[str, Instrument] = {}
    cash_interest: List[Income] = []
    fees: List[Movement] = []
    ignored_cash: List[Transaction] = []
    metals: List[Transaction] = []
    warnings: List[str] = []

    def get_instrument(t: Transaction) -> Instrument:
        isin, category, sec_type = _classify_instrument(t)
        key = _instrument_key(t, isin)
        inst = instruments.get(key)
        if inst is None:
            country = (isin[:2] if isin else CURRENCY_COUNTRY.get(t.currency, default_country))
            inst = Instrument(
                key=key,
                symbol=t.symbol,
                name=t.name or t.symbol or (isin or "Unknown"),
                isin=isin,
                currency=t.currency,
                country=country,
                category=category,
                security_type=sec_type,
            )
            instruments[key] = inst
        return inst

    for t in transactions:
        ttype = t.type

        if ttype in CASH_INTEREST_TYPES:
            gross = _gross_from(t) or Decimal(0)
            cash_interest.append(
                Income(t.date, ttype, gross, t.costs or Decimal(0),
                       t.net_amount or gross, t.currency, t.row_index)
            )
            continue

        if ttype in FEE_TYPES:
            fees.append(
                Movement(t.date, ttype, Decimal(0), t.unit_price,
                         _gross_from(t), t.costs, t.currency, t.order_number,
                         is_addition=False, source_row=t.row_index)
            )
            continue

        if ttype in CASH_MOVEMENT_TYPES:
            if t.currency == "XAU":
                metals.append(t)
            else:
                ignored_cash.append(t)
            continue

        # Everything below is tied to a specific security.
        if ttype in INCOME_TYPES:
            inst = get_instrument(t)
            gross = _gross_from(t) or Decimal(0)
            inst.income.append(
                Income(t.date, ttype, gross, t.costs or Decimal(0),
                       t.net_amount or gross, t.currency, t.row_index)
            )
            continue

        if ttype in BUY_TYPES or ttype in SELL_TYPES:
            inst = get_instrument(t)
            qty = t.quantity or Decimal(0)
            is_addition = ttype in BUY_TYPES
            signed = qty if is_addition else -qty
            inst.movements.append(
                Movement(t.date, ttype, signed, t.unit_price, _gross_from(t),
                         t.costs, t.currency, t.order_number,
                         is_addition=is_addition, source_row=t.row_index)
            )
            continue

        if ttype in FEE_CORRECTION_TYPES:
            # Tiny fee rebates tied to a trade – fold into fees for transparency,
            # they do not change quantities.
            inst = get_instrument(t)
            fees.append(
                Movement(t.date, ttype, Decimal(0), t.unit_price,
                         _gross_from(t), t.costs, t.currency, t.order_number,
                         is_addition=False, source_row=t.row_index)
            )
            continue

        if ttype in CORPORATE_ACTION_TYPES:
            inst = get_instrument(t)
            qty = t.quantity or Decimal(0)
            is_addition = qty >= 0
            inst.corporate_actions.append(
                Movement(t.date, ttype, qty, t.unit_price, _gross_from(t),
                         t.costs, t.currency, t.order_number,
                         is_addition=is_addition, source_row=t.row_index)
            )
            # A redemption can also carry a small income component.
            if ttype == "Rückzahlung" and t.net_amount and t.net_amount > 0:
                inst.income.append(
                    Income(t.date, ttype, _gross_from(t) or Decimal(0),
                           t.costs or Decimal(0), t.net_amount, t.currency, t.row_index)
                )
            continue

        # Unknown type – record a warning but never drop data silently.
        warnings.append(f"Unrecognised transaction type '{ttype}' (row {t.row_index}) was ignored.")
        ignored_cash.append(t)

    result = ClassificationResult(
        instruments=list(instruments.values()),
        cash_interest=cash_interest,
        fees=fees,
        ignored_cash=ignored_cash,
        metals=metals,
        warnings=warnings,
    )
    reconstruct_positions(result)
    return result


def chronological(movements: List[Movement]) -> List[Movement]:
    """Return movements oldest-first.

    Swissquote exports rows newest-first, so a *larger* ``source_row`` means an
    *earlier* event.  Sorting by date ascending with ``-source_row`` as the
    tie-breaker therefore yields true chronological order, even for several
    trades booked on the same day.
    """
    return sorted(movements, key=lambda m: (m.date, -m.source_row))


def reconstruct_positions(result: ClassificationResult) -> None:
    """Compute opening & closing quantities for every instrument.

    Transactions are processed oldest-first.  If the cumulative quantity ever
    drops below zero, the shortfall means the client already held that many
    units before the tax year, so we lift the opening balance accordingly and
    flag it as inferred.
    """
    for inst in result.instruments:
        events = chronological(inst.movements + inst.corporate_actions)
        running = Decimal(0)
        min_running = Decimal(0)
        for m in events:
            running += m.quantity
            if running < min_running:
                min_running = running

        opening = -min_running if min_running < 0 else Decimal(0)
        inst.opening_quantity = opening
        inst.opening_inferred = opening > 0
        inst.closing_quantity = opening + running
