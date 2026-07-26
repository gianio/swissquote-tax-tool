"""Build an eCH-0196 ``TaxStatement`` from classified Swissquote data.

This reuses the official eCH-0196 pydantic models shipped by the
``opensteuerauszug`` project, so the serialised XML follows the exact schema
used by the Swiss cantonal tax-declaration software.

What is exact vs. estimated
---------------------------
* **Quantities & movements** – reconstructed exactly from the CSV.
* **Income** (dividends, distributions, interest) – gross/net/withholding are
  exact in the original currency; the CHF figures use the user-supplied FX
  rates and are therefore estimates that the tax software recomputes from the
  official Kursliste.
* **Year-end tax value** – the CSV carries no 31.12 market price, so the value
  is estimated from the most recent trade price and flagged with
  ``kursliste=True`` so the tax software overrides it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import List, Optional

from opensteuerauszug.model.ech0196 import (
    BankAccount,
    BankAccountName,
    BankAccountPayment,
    Client,
    ClientNumber,
    Depot,
    DepotNumber,
    ISINType,
    Institution,
    ListOfBankAccounts,
    ListOfSecurities,
    Security,
    SecurityPayment,
    SecurityStock,
    SecurityTaxValue,
    TaxStatement,
)

from .classifier import ClassificationResult, Instrument, Movement, chronological
from .config import StatementConfig

_TWO = Decimal("0.01")


def _money(value: Optional[Decimal]) -> Optional[Decimal]:
    if value is None:
        return None
    return value.quantize(_TWO, rounding=ROUND_HALF_UP)


def _isin_or_none(inst: Instrument):
    if inst.isin:
        try:
            return ISINType(inst.isin)
        except Exception:  # pragma: no cover - defensive
            return None
    return None


@dataclass
class PositionReport:
    name: str
    isin: Optional[str]
    category: str
    currency: str
    closing_quantity: Decimal
    opening_inferred: bool
    tax_value_chf: Decimal
    gross_income_chf: Decimal
    value_is_estimate: bool


@dataclass
class BuildReport:
    included: List[PositionReport] = field(default_factory=list)
    excluded: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    total_tax_value_chf: Decimal = Decimal(0)
    total_gross_revenue_a_chf: Decimal = Decimal(0)
    total_gross_revenue_b_chf: Decimal = Decimal(0)
    total_withholding_tax_claim_chf: Decimal = Decimal(0)
    total_foreign_withholding_chf: Decimal = Decimal(0)
    total_bank_interest_chf: Decimal = Decimal(0)


def _build_bank_accounts(
    result: ClassificationResult, config: StatementConfig, report: BuildReport
) -> Optional[ListOfBankAccounts]:
    """Build one bank account per currency that received interest on deposits."""
    if not result.cash_interest:
        return None

    by_currency: dict[str, List] = {}
    for inc in result.cash_interest:
        by_currency.setdefault(inc.currency, []).append(inc)

    accounts: List[BankAccount] = []
    total_a = Decimal(0)
    for currency, incomes in sorted(by_currency.items()):
        rate = config.rate(currency)
        payments: List[BankAccountPayment] = []
        acc_gross = Decimal(0)
        for inc in sorted(incomes, key=lambda i: (i.date, i.source_row)):
            gross_chf = _money(inc.gross * rate) or Decimal(0)
            acc_gross += gross_chf
            payments.append(
                BankAccountPayment(
                    paymentDate=inc.date,
                    name="Zinsen auf Einlagen",
                    amountCurrency=currency,
                    amount=_money(inc.gross),
                    exchangeRate=rate,
                    grossRevenueA=gross_chf,
                    grossRevenueB=Decimal(0),
                    withHoldingTaxClaim=Decimal(0),
                )
            )
        total_a += acc_gross
        accounts.append(
            BankAccount(
                bankAccountName=BankAccountName(f"Swissquote {currency}"),
                bankAccountCurrency=currency,
                bankAccountCountry="CH",
                payment=payments,
                totalTaxValue=Decimal(0),
                totalGrossRevenueA=acc_gross,
                totalGrossRevenueB=Decimal(0),
                totalWithHoldingTaxClaim=Decimal(0),
            )
        )

    report.total_bank_interest_chf = total_a
    report.total_gross_revenue_a_chf += total_a
    return ListOfBankAccounts(
        bankAccount=accounts,
        totalTaxValue=Decimal(0),
        totalGrossRevenueA=_money(total_a),
        totalGrossRevenueB=Decimal(0),
        totalWithHoldingTaxClaim=Decimal(0),
    )


def _generate_statement_id(config: StatementConfig, period_to: date) -> str:
    """Build the 31-char eCH-0196 statement id.

    Format (eCH-0196 v2.1/2.2): ``CC NNNNN CCCCCCCCCCCCCC YYYYMMDD SS``
    = country(2) + clearing number(5) + customer id(14, X-padded) + date(8) +
    sequence(2).  The clearing number identifies the custodian bank; the render
    step reads it back from ``id[2:7]`` to place it on the barcode pages.
    """
    country = (config.country or "CH").upper()[:2].ljust(2, "X")
    clearing = re.sub(r"\D", "", config.institution_clearing or "06435")[:5].rjust(5, "0")
    customer = re.sub(r"[^A-Za-z0-9]", "", config.client_number or "")[:14].ljust(14, "X")
    return f"{country}{clearing}{customer}{period_to:%Y%m%d}01"


def _last_trade_price(inst: Instrument) -> Optional[Decimal]:
    """Most recent trade unit price – proxy for a year-end market price."""
    for m in reversed(chronological(inst.movements)):
        if m.unit_price and m.unit_price > 0:
            return m.unit_price
    return None


def _build_security(
    inst: Instrument,
    position_id: int,
    config: StatementConfig,
    report: BuildReport,
) -> Security:
    rate = config.rate(inst.currency)
    quotation = "PIECE"

    # --- Stock movements ---------------------------------------------------
    stock: List[SecurityStock] = [
        SecurityStock(
            referenceDate=config.period_from,
            mutation=False,
            quotationType=quotation,
            quantity=inst.opening_quantity,
            balanceCurrency=inst.currency,
            name="Bestand 01.01." + ("  (rekonstruiert)" if inst.opening_inferred else ""),
        )
    ]
    for m in chronological(inst.movements + inst.corporate_actions):
        stock.append(
            SecurityStock(
                referenceDate=m.date,
                mutation=True,
                quotationType=quotation,
                quantity=m.quantity,
                balanceCurrency=inst.currency,
                unitPrice=m.unit_price if (m.unit_price and m.unit_price > 0) else None,
                balance=_money(m.gross_amount),
                name=m.type,
            )
        )
    stock.append(
        SecurityStock(
            referenceDate=config.period_to,
            mutation=False,
            quotationType=quotation,
            quantity=inst.closing_quantity,
            balanceCurrency=inst.currency,
            name="Bestand 31.12.",
        )
    )

    # --- Year-end tax value ------------------------------------------------
    # The last trade price is a rough proxy for the 31.12 market price; we always
    # compute it for the dashboard, but only write it into the XML in "estimate"
    # mode. In "minimal" mode (default) the value is left undefined so the tax
    # software fills it from the official Kursliste – this is what makes the
    # import self-consistent (see StatementConfig.tax_value_mode).
    last_price = _last_trade_price(inst)
    estimate_chf = Decimal(0)
    if inst.closing_quantity != 0 and last_price is not None:
        estimate_chf = _money(inst.closing_quantity * last_price * rate) or Decimal(0)

    minimal = config.tax_value_mode != "estimate"
    value_is_estimate = False
    tax_value_chf = Decimal(0)
    tax_value = None
    if inst.closing_quantity != 0:
        if minimal:
            tax_value = SecurityTaxValue(
                referenceDate=config.period_to,
                quotationType=quotation,
                quantity=inst.closing_quantity,
                balanceCurrency=inst.currency,
                kursliste=True,      # value comes from the official Kursliste …
                undefined=True,      # … and is explicitly undefined in this file
            )
        else:
            value_is_estimate = last_price is not None
            tax_value_chf = estimate_chf if value_is_estimate else Decimal(0)
            tax_value = SecurityTaxValue(
                referenceDate=config.period_to,
                quotationType=quotation,
                quantity=inst.closing_quantity,
                balanceCurrency=inst.currency,
                unitPrice=last_price,
                balance=_money(inst.closing_quantity * last_price) if last_price else None,
                exchangeRate=rate,
                value=tax_value_chf if value_is_estimate else None,
                kursliste=True,
            )

    # --- Income (dividends / distributions) --------------------------------
    payments: List[SecurityPayment] = []
    gross_income_chf = Decimal(0)
    is_swiss = inst.country == "CH"
    for inc in sorted(inst.income, key=lambda i: (i.date, i.source_row)):
        gross_chf = _money(inc.gross * rate) or Decimal(0)
        tax_chf = _money(inc.tax * rate) or Decimal(0)
        gross_income_chf += gross_chf
        payment = SecurityPayment(
            paymentDate=inc.date,
            quotationType=quotation,
            quantity=Decimal(1),
            amountCurrency=inc.currency,
            amountPerUnit=_money(inc.gross),
            amount=_money(inc.gross),
            exchangeRate=rate,
            name=inc.type,
        )
        if is_swiss:
            # Swiss securities: 35 % Verrechnungssteuer is reclaimable.
            payment.grossRevenueA = gross_chf
            payment.withHoldingTaxClaim = tax_chf
            report.total_gross_revenue_a_chf += gross_chf
            report.total_withholding_tax_claim_chf += tax_chf
        else:
            # Foreign securities: income is type B; any tax withheld abroad is a
            # DA-1 / additional-withholding matter left for the tax software.
            payment.grossRevenueB = gross_chf
            report.total_gross_revenue_b_chf += gross_chf
            report.total_foreign_withholding_chf += tax_chf
        payments.append(payment)

    security = Security(
        positionId=position_id,
        country=inst.country,
        currency=inst.currency,
        quotationType=quotation,
        securityCategory=inst.category,
        securityName=inst.name or inst.symbol or "Unknown",
        isin=_isin_or_none(inst),
        symbol=inst.symbol or None,
        stock=stock,
        payment=payments,
        taxValue=tax_value,
    )

    # The header total only carries values actually written into the XML.
    report.total_tax_value_chf += tax_value_chf
    report.included.append(
        PositionReport(
            name=security.securityName,
            isin=inst.isin,
            category=inst.category,
            currency=inst.currency,
            closing_quantity=inst.closing_quantity,
            opening_inferred=inst.opening_inferred,
            tax_value_chf=estimate_chf,      # always the estimate, for the dashboard
            gross_income_chf=gross_income_chf,
            value_is_estimate=minimal or value_is_estimate,
        )
    )
    return security


def _build_metals_security(
    result: ClassificationResult, position_id: int, config: StatementConfig, report: BuildReport
) -> Optional[Security]:
    """Aggregate XAU (gold) forex legs into a single COINBULL position."""
    net = Decimal(0)
    movements: List[Movement] = []
    for t in result.metals:
        qty = t.net_amount or Decimal(0)   # already signed (credit +, debit -)
        net += qty
        movements.append(
            Movement(t.date, t.type, qty, t.unit_price, None, t.costs,
                     t.currency, t.order_number, is_addition=qty >= 0, source_row=t.row_index)
        )
    if net == 0:
        return None

    rate = config.rate("XAU")
    stock = [
        SecurityStock(referenceDate=config.period_from, mutation=False, quotationType="PIECE",
                      quantity=Decimal(0), balanceCurrency="XAU", name="Bestand 01.01.")
    ]
    for m in chronological(movements):
        stock.append(
            SecurityStock(referenceDate=m.date, mutation=True, quotationType="PIECE",
                          quantity=m.quantity, balanceCurrency="XAU", name=m.type)
        )
    stock.append(
        SecurityStock(referenceDate=config.period_to, mutation=False, quotationType="PIECE",
                      quantity=net, balanceCurrency="XAU", name="Bestand 31.12.")
    )
    estimate_chf = _money(net * rate) or Decimal(0)
    minimal = config.tax_value_mode != "estimate"
    if minimal:
        tax_value = SecurityTaxValue(
            referenceDate=config.period_to, quotationType="PIECE", quantity=net,
            balanceCurrency="XAU", kursliste=True, undefined=True,
        )
        value_in_xml = Decimal(0)
    else:
        tax_value = SecurityTaxValue(
            referenceDate=config.period_to, quotationType="PIECE", quantity=net,
            balanceCurrency="XAU", exchangeRate=rate, value=estimate_chf, kursliste=True,
        )
        value_in_xml = estimate_chf
    security = Security(
        positionId=position_id,
        country="XX",
        currency="XAU",
        quotationType="PIECE",
        securityCategory="COINBULL",
        securityType="COINBULL.GOLD",
        securityName="Gold (XAU)",
        stock=stock,
        taxValue=tax_value,
    )
    report.total_tax_value_chf += value_in_xml
    report.included.append(
        PositionReport("Gold (XAU)", None, "COINBULL", "XAU", net, False,
                       estimate_chf, Decimal(0), True)
    )
    return security


def build_statement(result: ClassificationResult, config: StatementConfig):
    """Build a validated eCH-0196 :class:`TaxStatement` and a :class:`BuildReport`."""
    report = BuildReport(warnings=list(result.warnings))

    securities: List[Security] = []
    position_id = 1
    for inst in result.instruments:
        if inst.is_option and not config.include_options:
            report.excluded.append(f"{inst.name} (Option – ausgeschlossen)")
            continue
        if inst.is_crypto and not config.include_crypto:
            report.excluded.append(f"{inst.name} (Krypto – ausgeschlossen)")
            continue
        securities.append(_build_security(inst, position_id, config, report))
        position_id += 1

    if config.include_metals:
        metal = _build_metals_security(result, position_id, config, report)
        if metal is not None:
            securities.append(metal)
            position_id += 1

    # Securities totals are snapshotted here, before bank interest is added to
    # the report, so listOfSecurities reflects securities only.
    list_of_securities = ListOfSecurities(
        depot=[Depot(depotNumber=DepotNumber(config.depot_number or "1"), security=securities)],
        totalTaxValue=_money(report.total_tax_value_chf),
        totalGrossRevenueA=_money(report.total_gross_revenue_a_chf),
        totalGrossRevenueB=_money(report.total_gross_revenue_b_chf),
        totalWithHoldingTaxClaim=_money(report.total_withholding_tax_claim_chf),
        totalLumpSumTaxCredit=Decimal(0),
        totalNonRecoverableTax=Decimal(0),
        totalAdditionalWithHoldingTaxUSA=Decimal(0),
        totalGrossRevenueIUP=Decimal(0),
        totalGrossRevenueConversion=Decimal(0),
    )

    # Bank-account interest (adds to the statement-level gross revenue A total).
    list_of_bank_accounts = _build_bank_accounts(result, config, report)

    institution = Institution(name=config.institution_name)
    if config.institution_lei:
        institution.lei = config.institution_lei

    client = Client(
        clientNumber=ClientNumber(config.client_number or "SQ-ACCOUNT"),
        firstName=config.first_name or None,
        lastName=config.last_name or None,
    )

    # Anchor the creation timestamp to the end of the tax period. Some cantonal
    # importers derive the tax year from creationDate rather than taxPeriod, so a
    # "now" timestamp (e.g. mid-2026 for a 2025 statement) would otherwise make
    # the statement look like it belongs to the wrong year.
    creation_date = datetime(config.tax_year, 12, 31, 12, 0, tzinfo=timezone.utc)

    statement = TaxStatement(
        minorVersion=2,
        id=_generate_statement_id(config, config.period_to),
        creationDate=creation_date,
        taxPeriod=config.tax_year,
        periodFrom=config.period_from,
        periodTo=config.period_to,
        country=config.country,
        canton=config.canton,
        institution=institution,
        client=[client],
        listOfSecurities=list_of_securities,
        totalTaxValue=_money(report.total_tax_value_chf),
        totalGrossRevenueA=_money(report.total_gross_revenue_a_chf),
        totalGrossRevenueB=_money(report.total_gross_revenue_b_chf),
        totalWithHoldingTaxClaim=_money(report.total_withholding_tax_claim_chf),
    )
    if list_of_bank_accounts is not None:
        statement.listOfBankAccounts = list_of_bank_accounts
    return statement, report
