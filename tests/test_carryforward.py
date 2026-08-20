from decimal import Decimal

import pytest

from backend.carryforward import (OpeningPosition, parse_carry_forward,
                                  valid_isin, valor_from_isin)
from backend.classifier import classify
from backend.config import StatementConfig
from backend.csv_parser import parse_transactions
from backend.statement_builder import build_statement
from backend.validation import validate_ech0196
from tests.conftest import SAMPLE_CSV


def test_valid_isin_filters_ibans():
    assert valid_isin("CH0038863350")     # Nestlé
    assert valid_isin("US0378331005")     # Apple
    # IBAN fragment that matches the loose pattern but isn't a security.
    assert not valid_isin("CH1908781000")
    assert not valid_isin("")


def test_valor_from_swiss_isin():
    assert valor_from_isin("CH0012214059") == 1221405
    assert valor_from_isin("US0378331005") is None


def _sample_statement_xml():
    res = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    stmt, _ = build_statement(res, StatementConfig(tax_year=2025, canton="GR", client_number="1"))
    return stmt.to_xml_bytes()


def test_parse_ech_xml_round_trip():
    positions = parse_carry_forward(_sample_statement_xml(), "prev.xml")
    by_isin = {p.isin: p for p in positions if p.isin}
    # Nestlé held 1 at year-end in the sample (bought 100, sold 99).
    assert "CH0038863350" in by_isin
    nesn = by_isin["CH0038863350"]
    assert nesn.quantity == Decimal("1")
    assert nesn.valor == 3886335


def test_carry_forward_sets_opening_and_binds():
    res = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    # Pretend last year closed with 100 Nestlé and give a foreign valor.
    opening = [
        OpeningPosition(isin="CH0038863350", quantity=Decimal("100"), valor=3886335),
        OpeningPosition(isin="US92826C8394", quantity=Decimal("5"), valor=1234567),
    ]
    cfg = StatementConfig(tax_year=2025, canton="GR", client_number="1")
    stmt, report = build_statement(res, cfg, opening_positions=opening)
    assert report.carried_count >= 1
    xml = stmt.to_xml_bytes().decode()
    # Nestlé opening balance is now 100 and flagged as carried from last year.
    assert 'quantity="100" balanceCurrency="CHF" name="Bestand 01.01.  (Vorjahr)"' in xml
    # The supplied foreign valor is emitted so softax can bind the title.
    assert 'valorNumber="1234567"' in xml
    assert validate_ech0196(stmt.to_xml_bytes()).valid


def test_opening_positions_accepts_dicts():
    res = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    stmt, report = build_statement(
        res, StatementConfig(tax_year=2025, client_number="1"),
        opening_positions=[{"isin": "CH0038863350", "quantity": "50"}],
    )
    assert report.carried_count == 1


# --- synthetic softax "Kontrollausdruck Wertschriftenverzeichnis" --------
#
# Built in-memory (no real financial document committed to the repo) to
# reproduce the exact column layout of a real softax export: a row marker
# ("°" for no-ISIN rows like accounts, "**" for ISIN-bearing securities) at
# x<40, the Stückzahl in x 74-95, then the ISIN/name, then a Steuerwert (CHF)
# figure much further right. The parser used to only recognise "°"/"~" as a
# block-starting marker, so every "**" row silently merged into the last "°"
# block and only one (wrong) position ever came out of a real file. ISINs
# below are public security identifiers (ABB, Apple, an iShares ETF) — not
# personal data.
def _softax_pdf_bytes() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    y = 260  # parser skips y<=250 to drop the repeated header legend

    def row(marker, qty, isin, name, kind, steuerwert):
        nonlocal y
        page.insert_text((21, y), marker, fontsize=8)
        page.insert_text((32, y), "-", fontsize=8)
        if qty is not None:
            page.insert_text((78, y), qty, fontsize=8)
        x = 93
        if isin:
            page.insert_text((x, y), isin + ",", fontsize=8)
            x += 8 * len(isin + ", ")
        words = name.split(" ")
        for i, word in enumerate(words):
            suffix = "," if i == len(words) - 1 else ""
            page.insert_text((x, y), word + suffix, fontsize=8)
            x += 8 * (len(word) + 2)
        page.insert_text((x, y), kind, fontsize=8)
        if steuerwert is not None:
            page.insert_text((428, y), steuerwert, fontsize=8)
        y += 13

    # No-ISIN rows (accounts / unlisted funds) use "°" — these must NOT
    # swallow the "**" rows that follow.
    row("°", None, "", "CH00 0000 0000 0000 0000 0 Fake Bank AG", "PK", "5000")
    row("°", "12", "", "Fake Fund Units", "AF", "2400")
    # ISIN-bearing rows use "**". Steuerwert (decoy CHF figure) is
    # deliberately far from the Stückzahl so a column mix-up is obvious.
    row("**", "10", "CH0012221716", "ABB AG", "Akt", "99999")
    row("**", "65", "IE00B4L5Y983", "iShares Core MSCI World", "AF", "88888")
    row("**", "3", "US0378331005", "Apple Inc", "Akt", "12345")

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


_EXPECTED_SOFTAX_POSITIONS = {
    "CH0012221716": Decimal("10"),   # decoy Steuerwert 99999
    "IE00B4L5Y983": Decimal("65"),   # decoy Steuerwert 88888
    "US0378331005": Decimal("3"),    # decoy Steuerwert 12345
}


def test_parse_softax_pdf_recovers_all_isin_positions():
    positions = parse_carry_forward(_softax_pdf_bytes(), "test.pdf")
    by_isin = {p.isin: p for p in positions}
    assert set(by_isin) == set(_EXPECTED_SOFTAX_POSITIONS)


def test_parse_softax_pdf_quantity_is_stueckzahl_not_steuerwert():
    # Regression guard for the "**"-marker bug: quantities must match the
    # Stückzahl column, never fall back to reading the Steuerwert (CHF) column,
    # and every "**" row must survive as its own position (not get merged
    # into the preceding "°" block).
    positions = parse_carry_forward(_softax_pdf_bytes(), "test.pdf")
    by_isin = {p.isin: p for p in positions}
    for isin, expected_qty in _EXPECTED_SOFTAX_POSITIONS.items():
        assert by_isin[isin].quantity == expected_qty, isin


def test_parse_softax_pdf_names_have_spaces():
    positions = parse_carry_forward(_softax_pdf_bytes(), "test.pdf")
    by_isin = {p.isin: p for p in positions}
    assert by_isin["CH0012221716"].name == "ABB AG"
    assert by_isin["US0378331005"].name == "Apple Inc"
