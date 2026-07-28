"""Parser for Swissquote transaction CSV exports.

The Swissquote "Transactions" export is a semicolon-delimited file, encoded in
Latin-1 (ISO-8859-1), with German column headers::

    Datum;Auftrag #;Transaktionen;Symbol;Name;ISIN;Anzahl;Stückpreis;Kosten;
    Aufgelaufene Zinsen;Nettobetrag;Saldo;Währung

Amounts use a ``.`` decimal separator and no thousands separator.  Empty numeric
cells are sometimes exported as ``-``.  This module turns each data row into a
normalised :class:`Transaction` dataclass with proper Python types so the rest
of the pipeline never has to worry about encoding or locale quirks.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import List, Optional

# Canonical header names (after normalisation) we expect to find.
EXPECTED_COLUMNS = [
    "Datum",
    "Auftrag #",
    "Transaktionen",
    "Symbol",
    "Name",
    "ISIN",
    "Anzahl",
    "Stückpreis",
    "Kosten",
    "Aufgelaufene Zinsen",
    "Nettobetrag",
    "Saldo",
    "Währung",
]


class CsvParseError(ValueError):
    """Raised when the uploaded file does not look like a Swissquote export."""


@dataclass
class Transaction:
    """A single, normalised row of the Swissquote export."""

    row_index: int
    date: date
    time: Optional[str]
    order_number: str
    type: str
    symbol: str
    name: str
    isin: str
    quantity: Optional[Decimal]
    unit_price: Optional[Decimal]
    costs: Optional[Decimal]
    accrued_interest: Optional[Decimal]
    net_amount: Optional[Decimal]
    balance: Optional[Decimal]
    currency: str
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def is_placeholder_order(self) -> bool:
        """Swissquote uses ``00000000`` for non-trade bookings (dividends, fees)."""
        return self.order_number in ("", "00000000")


def _decode(data: bytes) -> str:
    """Decode raw upload bytes, preferring the Swissquote Latin-1 encoding.

    Falls back to UTF-8 (with BOM handling) in case a user re-saved the file.
    """
    # A UTF-8 BOM is a strong signal the file was re-encoded to UTF-8.
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig")
    for encoding in ("cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            # Heuristic: the German headers must survive decoding.
            if "Transaktionen" in text:
                return text
        except UnicodeDecodeError:
            continue
    # Last resort – never blow up on a stray byte.
    return data.decode("utf-8", errors="replace")


def _normalise_header(name: str) -> str:
    return name.strip().lstrip("﻿")


def _parse_decimal(value: str) -> Optional[Decimal]:
    """Parse a Swissquote numeric cell, returning ``None`` for blanks/``-``."""
    if value is None:
        return None
    v = value.strip()
    if v in ("", "-", "--"):
        return None
    # Some locales sneak in a thousands separator or a stray currency space.
    v = v.replace("'", "").replace(" ", "")
    try:
        return Decimal(v)
    except (InvalidOperation, ValueError):
        return None


def _parse_datetime(value: str) -> tuple[date, Optional[str]]:
    """Parse ``31-12-2025 12:08:52`` (or just the date) into (date, time-str)."""
    v = (value or "").strip()
    if not v:
        raise CsvParseError("Row is missing a date value")
    date_part, _, time_part = v.partition(" ")
    for fmt in ("%d-%m-%Y", "%d.%m.%Y", "%Y-%m-%d"):
        try:
            d = datetime.strptime(date_part, fmt).date()
            return d, (time_part or None)
        except ValueError:
            continue
    raise CsvParseError(f"Unrecognised date format: {value!r}")


def parse_transactions(data: bytes) -> List[Transaction]:
    """Parse raw CSV bytes into a list of :class:`Transaction`.

    Rows are returned in the order they appear in the file (Swissquote exports
    newest-first).  Raises :class:`CsvParseError` on a structurally invalid file.
    """
    text = _decode(data)
    # Sniff the delimiter but strongly prefer ';' which Swissquote always uses.
    sample = text[:2048]
    delimiter = ";" if sample.count(";") >= sample.count(",") else ","

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = list(reader)
    if not rows:
        raise CsvParseError("The file is empty.")

    header = [_normalise_header(h) for h in rows[0]]
    if "Transaktionen" not in header:
        raise CsvParseError(
            "This does not look like a Swissquote transactions export "
            "(missing the 'Transaktionen' column)."
        )

    idx = {name: i for i, name in enumerate(header)}

    def cell(row: List[str], name: str) -> str:
        i = idx.get(name)
        if i is None or i >= len(row):
            return ""
        return row[i].strip()

    transactions: List[Transaction] = []
    for row_index, row in enumerate(rows[1:], start=2):
        # Skip blank trailing lines.
        if not any(c.strip() for c in row):
            continue
        try:
            d, t = _parse_datetime(cell(row, "Datum"))
        except CsvParseError:
            # A row without a valid date is not a real transaction – skip it.
            continue

        transactions.append(
            Transaction(
                row_index=row_index,
                date=d,
                time=t,
                order_number=cell(row, "Auftrag #"),
                type=cell(row, "Transaktionen"),
                symbol=cell(row, "Symbol"),
                name=cell(row, "Name"),
                isin=cell(row, "ISIN"),
                quantity=_parse_decimal(cell(row, "Anzahl")),
                unit_price=_parse_decimal(cell(row, "Stückpreis")),
                costs=_parse_decimal(cell(row, "Kosten")),
                accrued_interest=_parse_decimal(cell(row, "Aufgelaufene Zinsen")),
                net_amount=_parse_decimal(cell(row, "Nettobetrag")),
                balance=_parse_decimal(cell(row, "Saldo")),
                currency=cell(row, "Währung"),
                raw={name: (row[i] if i < len(row) else "") for name, i in idx.items()},
            )
        )

    if not transactions:
        raise CsvParseError("No transactions found in the file.")
    return transactions


def infer_tax_year(transactions: List[Transaction]) -> int:
    """Return the most common calendar year across the transactions."""
    from collections import Counter

    years = Counter(t.date.year for t in transactions)
    return years.most_common(1)[0][0]
