"""Read *previous / existing* positions so the new statement carries them forward.

Goal: when a title is already listed in the tax software (from last year), this
year's trades should bind onto that existing position instead of creating a
duplicate. softax matches by **Valorennummer / ISIN**, and reconciles
``Anfangsbestand (this year) == Endbestand (last year)``. So we need each
position's opening quantity and its valor.

Two accepted sources (the user picks whichever they have):

1. **Last year's eCH-0196 XML** – exact: every ``<security>`` carries valor,
   ISIN and its year-end quantity (= this year's opening).
3. **A softax "Wertschriften- und Guthabenverzeichnis" PDF** – a control
   printout; we extract ISIN, name and the year-end Stückzahl by position.
   Robust for identity; quantities are best-effort and meant to be reviewed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import List, Optional

_ISIN_RE = re.compile(r"[A-Z]{2}[A-Z0-9]{9}[0-9]")


@dataclass
class OpeningPosition:
    isin: str
    name: str = ""
    valor: Optional[int] = None
    quantity: Optional[Decimal] = None
    source: str = ""


def valid_isin(isin: str) -> bool:
    """Validate an ISIN by its check digit (mod-10 / Luhn on letter-expanded digits).

    Filters out look-alikes such as IBAN fragments (CH + digits) that match the
    ISIN pattern but aren't securities.
    """
    if not isin or len(isin) != 12 or not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", isin):
        return False
    digits = "".join(str(ord(c) - 55) if c.isalpha() else c for c in isin)
    total, dbl = 0, False
    for d in reversed(digits):
        n = int(d)
        if dbl:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        dbl = not dbl
    return total % 10 == 0


def valor_from_isin(isin: str) -> Optional[int]:
    if not isin or len(isin) != 12 or not isin.startswith("CH"):
        return None
    digits = isin[2:11]
    if not digits.isdigit():
        return None
    v = int(digits)
    return v if 100 <= v <= 999_999_999_999 else None


def _num(s) -> Optional[Decimal]:
    if s is None:
        return None
    t = str(s).strip().replace("’", "").replace("'", "").replace(" ", "")
    if t in ("", "-"):
        return None
    try:
        return Decimal(t)
    except (InvalidOperation, ValueError):
        return None


def parse_carry_forward(data: bytes, filename: Optional[str] = None) -> List[OpeningPosition]:
    """Parse an eCH-0196 XML or a softax Wertschriftenverzeichnis PDF."""
    head = data[:512].lstrip()
    is_pdf = data[:5] == b"%PDF-" or (filename or "").lower().endswith(".pdf")
    is_xml = head[:1] == b"<" or b"taxStatement" in data[:4096] or (filename or "").lower().endswith(".xml")
    if is_pdf:
        return _parse_softax_pdf(data)
    if is_xml:
        return _parse_ech_xml(data)
    raise ValueError("Unbekanntes Format – erwartet eCH-0196 XML oder softax-PDF.")


# --- eCH-0196 XML --------------------------------------------------------
def _parse_ech_xml(data: bytes) -> List[OpeningPosition]:
    from lxml import etree

    root = etree.fromstring(data)
    ns = {"e": "http://www.ech.ch/xmlns/eCH-0196/2"}
    positions: List[OpeningPosition] = []
    securities = root.findall(".//e:security", ns) or root.findall(".//security")
    for sec in securities:
        isin = sec.get("isin") or ""
        name = sec.get("securityName") or ""
        valor = sec.get("valorNumber")
        # Year-end quantity: prefer taxValue, else the latest closing stock balance.
        qty = None
        tv = sec.find("e:taxValue", ns)
        if tv is None:
            tv = sec.find("taxValue")
        if tv is not None and tv.get("quantity") is not None:
            qty = _num(tv.get("quantity"))
        if qty is None:
            balances = [s for s in (sec.findall("e:stock", ns) or sec.findall("stock"))
                        if s.get("mutation") in ("0", "false")]
            if balances:
                qty = _num(balances[-1].get("quantity"))
        positions.append(OpeningPosition(
            isin=isin, name=name,
            valor=int(valor) if valor and valor.isdigit() else valor_from_isin(isin),
            quantity=qty, source="ech-xml",
        ))
    return positions


# --- softax Wertschriftenverzeichnis PDF ---------------------------------
def _concat(words) -> str:
    s, lastx = "", None
    for w in sorted(words, key=lambda w: w[0]):
        if lastx is not None and w[0] - lastx > 3:
            s += " "
        s += w[4]
        lastx = w[2]
    return s


def _parse_softax_pdf(data: bytes) -> List[OpeningPosition]:
    import fitz
    from collections import defaultdict

    doc = fitz.open(stream=data, filetype="pdf")
    positions: List[OpeningPosition] = []
    seen = set()
    for pi in range(doc.page_count):
        lines = defaultdict(list)
        for w in doc[pi].get_text("words"):
            lines[round(w[1])].append(w)
        ys = [y for y in sorted(lines) if y > 250]   # skip the repeated header legend
        # Split into position blocks delimited by the row markers (°/~ at far left).
        blocks, cur = [], None
        for y in ys:
            toks = sorted(lines[y], key=lambda w: w[0])
            is_marker = toks and toks[0][0] < 40 and re.match(r"^[°~]", toks[0][4])
            if is_marker:
                if cur:
                    blocks.append(cur)
                cur = [(y, toks)]
            elif cur is not None:
                cur.append((y, toks))
        if cur:
            blocks.append(cur)

        for blk in blocks:
            text = " ".join(_concat(ts) for _, ts in blk)
            m = _ISIN_RE.search(text)
            if not m:
                continue
            isin = m.group(0)
            if not valid_isin(isin) or isin in seen:   # skip IBANs / non-security look-alikes
                continue
            seen.add(isin)
            # Stückzahl (year-end holdings): digit tokens in the Stückzahl column
            # (x 74..95) on the marker line only, to avoid "CHF" and footer text.
            _, mtoks = blk[0]
            digits = "".join(t[4] for t in sorted(mtoks, key=lambda w: w[0])
                              if 74 <= t[0] <= 95 and t[4].isdigit())
            after = text.split(isin + ",", 1)[1].strip() if isin + "," in text else ""
            name = after.split(",")[0].strip()
            positions.append(OpeningPosition(
                isin=isin, name=name, valor=valor_from_isin(isin),
                quantity=_num(digits), source="softax-pdf",
            ))
    return positions
