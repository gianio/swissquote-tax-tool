"""Parser for the Swissquote *Kontoauszug* (account statement) PDF.

Unlike the transactions CSV, the yearly Kontoauszug PDF additionally contains

* the **per-currency year-end cash balances** (Kontostände), and
* the **account holder identity** (name, IBAN, customer number),

so uploading the PDF fills in information the CSV can't provide.

The PDF is a column layout (DATUM · INFORMATION · REFERENZ · BELASTUNG ·
GUTSCHRIFT · VALUTA-DATUM · SALDO), one section per currency.  We read it with
word coordinates (via PyMuPDF) and assign each token to a column by its
x-position, which is far more robust than line-based text scraping.  Every
transaction is normalised into the same :class:`~backend.csv_parser.Transaction`
dataclass used for the CSV, so the rest of the pipeline is unchanged.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Optional

from .csv_parser import CsvParseError, Transaction

# Column boundaries (x-coordinate, page width ~595pt). Tokens are bucketed by the
# right edge they fall under.
_COL_BOUNDS = [
    (74, "date"),
    (223, "info"),
    (276, "ref"),
    (345, "belastung"),
    (418, "gutschrift"),
    (505, "valuta"),
    (10_000, "saldo"),
]

_DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
_SECTION_RE = re.compile(r"Kontoauszug in (\w{3})")
_SYMBOL_RE = re.compile(r"\(([^)]+)\)\s*$")
_ISIN_RE = re.compile(r"ISIN:\s*([A-Z0-9]{12})")

# Map the German Kontoauszug labels to the canonical transaction types the
# classifier already understands (same vocabulary as the CSV export).
_TYPE_MAP = {
    "Kauf": "Kauf",
    "Verkauf": "Verkauf",
    "Dividende": "Dividende",
    "Kapitalgewinn": "Capital Gain",
    "Zahlung per Debitkarte": "Kartentransaktion",
    "Zahlung von": "Zahlung",
    "Depotgebühren": "Depotgebühren",
    "Börsengebühren": "Berichtigung Börsengeb.",
    "Kommission": "Berichtigung Börsengeb.",
    "Sollzinsen": "Berichtigung Börsengeb.",
    "Zinsen aus anderen Konten": "Zinsen auf Einlagen",
    "zu zahlende Optionsprämie": "Buy-to-Open",
    "Rückzahlung": "Rückzahlung",
}
# Types that only mark balances – never real transactions.
_SKIP_TYPES = {"Anfangsbestand", "Schlussbilanz"}


@dataclass
class CashBalance:
    currency: str
    amount: Decimal


@dataclass
class AccountInfo:
    holder_name: str = ""
    iban: str = ""
    customer_number: str = ""


@dataclass
class KontoauszugData:
    transactions: List[Transaction]
    balances: List[CashBalance]
    account: AccountInfo
    period_from: Optional[datetime] = None
    period_to: Optional[datetime] = None


def _column_of(x: float) -> str:
    for bound, name in _COL_BOUNDS:
        if x < bound:
            return name
    return "saldo"


def _num(text: str) -> Optional[Decimal]:
    """Parse a Swiss-formatted number (1'234.56, -0.03) or return None."""
    t = (text or "").strip().replace("’", "").replace("'", "").replace(" ", "")
    if not t or t in ("-", "--"):
        return None
    try:
        return Decimal(t)
    except (InvalidOperation, ValueError):
        return None


def _looks_like_swissquote_konto(text: str) -> bool:
    return "Kontoauszug" in text and "Swissquote" in text


def parse_kontoauszug(data: bytes) -> KontoauszugData:
    """Parse Swissquote Kontoauszug PDF bytes into transactions + balances."""
    try:
        import fitz  # PyMuPDF
    except Exception as exc:  # pragma: no cover - dependency guaranteed in prod
        raise CsvParseError(f"PDF support unavailable: {exc}") from exc

    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise CsvParseError(f"Could not open the PDF: {exc}") from exc

    first_text = doc[0].get_text() if doc.page_count else ""
    if not _looks_like_swissquote_konto(first_text):
        raise CsvParseError(
            "This does not look like a Swissquote Kontoauszug PDF."
        )

    account = _parse_identity(first_text)
    balances = _parse_balances(first_text)
    period_from, period_to = _parse_period(first_text)

    raw_txns = _parse_transactions(doc)
    _backfill_isins(raw_txns)

    # The PDF lists transactions oldest-first within each currency section. The
    # rest of the pipeline expects the Swissquote CSV convention (newest-first,
    # so a larger row index means an older event). Reversing and numbering from 1
    # reproduces that convention exactly.
    raw_txns.reverse()
    transactions: List[Transaction] = []
    for i, t in enumerate(raw_txns, start=1):
        t.row_index = i
        transactions.append(t)

    if not transactions:
        raise CsvParseError("No transactions found in the Kontoauszug PDF.")

    return KontoauszugData(
        transactions=transactions,
        balances=balances,
        account=account,
        period_from=period_from,
        period_to=period_to,
    )


def _backfill_isins(txns: List[Transaction]) -> None:
    """Dividend rows carry no ISIN line – fill it in from the trades.

    Trades (Kauf/Verkauf) always print the ISIN, dividends/capital gains only
    the symbol and name. We build symbol→ISIN and name→ISIN maps from the rows
    that do have an ISIN, then backfill the rest so a security's income and
    trades collapse into a single position.
    """
    by_symbol: Dict[str, str] = {}
    by_name: Dict[str, str] = {}
    for t in txns:
        if t.isin:
            if t.symbol:
                by_symbol.setdefault(t.symbol, t.isin)
            if t.name:
                by_name.setdefault(t.name.upper(), t.isin)
    for t in txns:
        if not t.isin:
            t.isin = by_symbol.get(t.symbol) or by_name.get(t.name.upper(), "")


def _parse_identity(text: str) -> AccountInfo:
    info = AccountInfo()
    m = re.search(r"(?:Herrn|Frau|Herr)\s+([^\n]+)", text)
    if m:
        info.holder_name = m.group(1).strip()
    m = re.search(r"IBAN[^\n]*\n\s*([A-Z]{2}[0-9 ]{15,34})", text)
    if m:
        info.iban = re.sub(r"\s+", "", m.group(1)).strip()
    m = re.search(r"Kunde\s*\n?\s*(\d{4,})", text)
    if m:
        info.customer_number = m.group(1).strip()
    return info


def _parse_period(text: str):
    m = re.search(r"vom (\d{2}\.\d{2}\.\d{4}) bis (\d{2}\.\d{2}\.\d{4})", text)
    if not m:
        return None, None
    fmt = "%d.%m.%Y"
    return datetime.strptime(m.group(1), fmt), datetime.strptime(m.group(2), fmt)


def _parse_balances(text: str) -> List[CashBalance]:
    """Year-end balances from the 'Endsaldo aufgeteilt auf alle Währungen' block."""
    balances: List[CashBalance] = []
    block = text.split("aufgeteilt auf alle Währungen", 1)
    if len(block) < 2:
        return balances
    seen = set()
    for m in re.finditer(r"(-?[\d’']*\.?\d+)\s+([A-Z]{3})", block[1]):
        amount = _num(m.group(1))
        ccy = m.group(2)
        if amount is None or ccy in seen:
            continue
        seen.add(ccy)
        balances.append(CashBalance(currency=ccy, amount=amount))
    return balances


def _parse_transactions(doc) -> List[Transaction]:
    transactions: List[Transaction] = []
    current_ccy: Optional[str] = None
    pending: Optional[dict] = None

    def finalise(rec: Optional[dict]):
        if rec is None:
            return
        txn = _record_to_transaction(rec)
        if txn is not None:
            transactions.append(txn)

    for page_index in range(doc.page_count):
        page = doc[page_index]
        section = _SECTION_RE.search(page.get_text())
        if section:
            finalise(pending)
            pending = None
            current_ccy = section.group(1)

        # Group words into visual lines by rounded y, then split into columns.
        lines: Dict[int, list] = defaultdict(list)
        for w in page.get_text("words"):
            lines[round(w[1])].append(w)

        for y in sorted(lines):
            cols: Dict[str, list] = defaultdict(list)
            for w in sorted(lines[y], key=lambda w: w[0]):
                cols[_column_of(w[0])].append(w[4])
            date_text = " ".join(cols.get("date", [])).strip()
            info_text = " ".join(cols.get("info", [])).strip()

            if _DATE_RE.match(date_text):
                finalise(pending)
                pending = {
                    "ccy": current_ccy,
                    "date": date_text,
                    "type": info_text,
                    "ref": " ".join(cols.get("ref", [])).strip(),
                    "belastung": " ".join(cols.get("belastung", [])).strip(),
                    "gutschrift": " ".join(cols.get("gutschrift", [])).strip(),
                    "info_lines": [],
                }
            elif pending is not None:
                if info_text:
                    pending["info_lines"].append(info_text)
                for key in ("belastung", "gutschrift"):
                    val = " ".join(cols.get(key, [])).strip()
                    if val and not pending[key]:
                        pending[key] = val

    finalise(pending)
    return transactions


_CCY_RE = re.compile(r"^[A-Z]{3}$")


def _extract_info(lines: List[str]) -> dict:
    """Pull Anzahl/Preis/Betrag/Kommission/Taxen/ISIN/name out of info lines.

    Money labels keep their currency too (``betrag_ccy`` …) because a dividend's
    Betrag/Taxen/Total can be quoted in the security's own currency even when the
    cash is credited in the account's section currency.
    """
    out: dict = {"name": "", "symbol": "", "isin": ""}
    labelled = {
        "Anzahl": "anzahl",
        "Preis": "preis",
        "Betrag": "betrag",
        "Kommission": "kommission",
        "Taxen": "taxen",
        "Total": "total",
    }
    for line in lines:
        matched = False
        for label, key in labelled.items():
            if line.startswith(label + ":"):
                rest = line.split(":", 1)[1].strip()
                parts = rest.split()
                out[key] = _num(parts[-1]) if parts else None
                if len(parts) >= 2 and _CCY_RE.match(parts[-2]):
                    out[key + "_ccy"] = parts[-2]
                matched = True
                break
        if matched:
            continue
        mi = _ISIN_RE.search(line)
        if mi:
            out["isin"] = mi.group(1)
            continue
        if line.startswith(("Handelsplatz:", "Referenz", "Kurs:")):
            continue
        # The first free-text line is the security name "NAME (SYM)".
        if not out["name"] and _SYMBOL_RE.search(line):
            ms = _SYMBOL_RE.search(line)
            out["symbol"] = ms.group(1)
            out["name"] = line[: ms.start()].strip()
        elif not out["name"] and line:
            out["name"] = line
    return out


def _record_to_transaction(rec: dict) -> Optional[Transaction]:
    raw_type = (rec.get("type") or "").strip()
    base_type = raw_type.split("\n")[0].strip()
    if not base_type or base_type in _SKIP_TYPES:
        return None

    ccy = rec.get("ccy") or "CHF"
    belastung = _num(rec.get("belastung"))
    gutschrift = _num(rec.get("gutschrift"))
    info = _extract_info(rec.get("info_lines", []))

    # Currency conversions and gold trades map to the CSV's forex vocabulary,
    # with the debit/credit direction taken from which column carries the amount.
    if base_type in ("Automatisierter Währungstausch", "Währungsumtausch"):
        mapped = "Fx-Gutschrift Comp." if gutschrift else "Fx-Belastung Comp."
    elif base_type in ("Kauf FOREX", "Verkauf FOREX"):
        mapped = "Forex-Gutschrift" if gutschrift else "Forex-Belastung"
    else:
        mapped = _TYPE_MAP.get(base_type)
        if mapped is None:
            # Unknown label – keep it so the classifier can warn, not silently drop.
            mapped = base_type

    try:
        date = datetime.strptime(rec["date"], "%d.%m.%Y").date()
    except (KeyError, ValueError):
        return None

    # Net cash flow in the section currency: credit positive, debit negative.
    net = gutschrift if gutschrift is not None else (-belastung if belastung is not None else None)

    taxen = info.get("taxen") or Decimal(0)
    kommission = info.get("kommission") or Decimal(0)

    if mapped in ("Dividende", "Capital Gain"):
        # The true gross is Betrag and the total withholding is Betrag − net,
        # but only when Betrag is quoted in the account's section currency. When
        # the dividend is declared in a foreign currency (e.g. JPY paid into a
        # CHF account) those figures aren't comparable to the CHF credit, so we
        # fall back to the credited net amount.
        betrag = info.get("betrag")
        betrag_ccy = info.get("betrag_ccy")
        if betrag is not None and net is not None and (betrag_ccy is None or betrag_ccy == ccy):
            costs = betrag - net           # recoverable + non-recoverable withholding
        else:
            costs = Decimal(0)
    else:
        costs = taxen + kommission         # trade fees (tax-irrelevant)

    quantity = info.get("anzahl")
    unit_price = info.get("preis")

    return Transaction(
        row_index=0,  # assigned by the caller
        date=date,
        time=None,
        order_number=rec.get("ref", ""),
        type=mapped,
        symbol=info.get("symbol", ""),
        name=info.get("name", ""),
        isin=info.get("isin", ""),
        quantity=quantity,
        unit_price=unit_price,
        costs=costs,
        accrued_interest=Decimal(0),
        net_amount=net,
        balance=None,
        currency=ccy,
        raw=rec,
    )
