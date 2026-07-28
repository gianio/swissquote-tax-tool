"""Unified entry point that accepts either a Swissquote CSV or Kontoauszug PDF.

The two formats carry overlapping transaction data; the PDF additionally has the
per-currency year-end cash balances and the account holder's identity. This
module sniffs the format and returns one normalised :class:`ParsedInput`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .csv_parser import CsvParseError, Transaction, parse_transactions
from .pdf_parser import AccountInfo, CashBalance, parse_kontoauszug


@dataclass
class ParsedInput:
    transactions: List[Transaction]
    cash_balances: List[CashBalance] = field(default_factory=list)
    account: AccountInfo = field(default_factory=AccountInfo)
    source: str = "csv"          # "csv" or "pdf"


def _looks_like_pdf(data: bytes, filename: Optional[str]) -> bool:
    if data[:5] == b"%PDF-":
        return True
    return bool(filename and filename.lower().endswith(".pdf"))


def parse_input(data: bytes, filename: Optional[str] = None) -> ParsedInput:
    """Parse an uploaded Swissquote export (CSV or Kontoauszug PDF)."""
    if _looks_like_pdf(data, filename):
        k = parse_kontoauszug(data)
        return ParsedInput(
            transactions=k.transactions,
            cash_balances=k.balances,
            account=k.account,
            source="pdf",
        )
    # Default: the transactions CSV.
    return ParsedInput(transactions=parse_transactions(data), source="csv")


def split_name(full: str) -> tuple[str, str]:
    """Split 'Gian-Andri Morf' into (first, last); best-effort."""
    parts = (full or "").split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]
