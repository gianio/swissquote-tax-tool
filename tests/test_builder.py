from decimal import Decimal

import pytest

from backend.classifier import classify
from backend.config import StatementConfig
from backend.csv_parser import parse_transactions
from backend.statement_builder import build_statement
from backend.validation import validate_ech0196
from tests.conftest import SAMPLE_CSV


@pytest.fixture
def built():
    result = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    cfg = StatementConfig(tax_year=2025, canton="ZH", first_name="Test",
                          last_name="Person", client_number="123456")
    return build_statement(result, cfg)


def test_statement_validates_against_xsd(built):
    statement, _ = built
    result = validate_ech0196(statement.to_xml_bytes())
    assert result.valid, result.errors


def test_swiss_withholding_is_claimed(built):
    _, report = built
    # NESTLE dividend: 35 % VST (13.88 CHF) must be a reclaimable claim.
    assert report.total_withholding_tax_claim_chf == Decimal("13.88")
    assert report.total_gross_revenue_a_chf >= Decimal("39.65")


def test_foreign_income_is_type_b(built):
    _, report = built
    # VISA/VGIT are foreign -> revenue B, not claimed as Swiss VST.
    assert report.total_gross_revenue_b_chf > 0


def test_bank_interest_included(built):
    statement, report = built
    assert statement.listOfBankAccounts is not None
    assert report.total_bank_interest_chf > 0


def test_excluding_crypto_and_options():
    result = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    cfg = StatementConfig(tax_year=2025, include_crypto=False, include_options=False)
    statement, report = build_statement(result, cfg)
    names = [s.securityName for s in statement.listOfSecurities.depot[0].security]
    assert not any("BTC" in n for n in names)
    assert len(report.excluded) >= 2
    # Still valid XML after exclusions.
    assert validate_ech0196(statement.to_xml_bytes()).valid


def test_totals_are_present_for_schema(built):
    statement, _ = built
    assert statement.totalTaxValue is not None
    assert statement.totalGrossRevenueA is not None
    assert statement.totalGrossRevenueB is not None
    assert statement.totalWithHoldingTaxClaim is not None


def test_statement_id_is_ech_format(built):
    statement, _ = built
    # 31 chars: CH + clearing(5) + customer(14) + date(8) + seq(2)
    assert len(statement.id) == 31
    assert statement.id.startswith("CH06435")
    assert statement.id.endswith("2025123101")


def test_barcode_pdf_renders(built):
    statement, _ = built
    from backend.pdf_render import render_pdf

    pdf = render_pdf(statement)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 20_000  # a multi-page statement with barcode pages
