"""Validate generated XML against the vendored eCH-0196 XSD schema.

Unlike ``TaxStatement.validate_model`` (which looks for a ``specs`` directory
relative to the current working directory) this resolves the schema by absolute
path, so validation works no matter where the server is started from.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List

from lxml import etree

SPECS_DIR = Path(__file__).resolve().parent.parent / "specs"
MAIN_XSD = SPECS_DIR / "eCH-0196-2-2.xsd"


@dataclass
class ValidationResult:
    valid: bool
    errors: List[str]
    schema_available: bool = True


class _LocalResolver(etree.Resolver):
    """Resolve imported eCH schemas from the local specs directory."""

    def resolve(self, url, pubid, context):  # noqa: D401 - lxml callback
        if not url:
            return None
        candidate = SPECS_DIR / url.rsplit("/", 1)[-1]
        if candidate.exists():
            return self.resolve_filename(str(candidate), context)
        return None


def validate_ech0196(xml_bytes: bytes) -> ValidationResult:
    """Validate ``xml_bytes`` against eCH-0196 v2.2, returning a result object."""
    if not MAIN_XSD.exists():
        return ValidationResult(valid=False, errors=["XSD schema not found."], schema_available=False)

    try:
        parser = etree.XMLParser()
        parser.resolvers.add(_LocalResolver())
        schema_doc = etree.parse(str(MAIN_XSD), parser=parser)
        schema = etree.XMLSchema(schema_doc)
    except etree.XMLSchemaParseError as exc:  # pragma: no cover - schema is static
        return ValidationResult(valid=False, errors=[f"Could not load schema: {exc}"])

    try:
        doc = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError as exc:
        return ValidationResult(valid=False, errors=[f"XML syntax error: {exc}"])

    if schema.validate(doc):
        return ValidationResult(valid=True, errors=[])
    return ValidationResult(valid=False, errors=[str(e) for e in schema.error_log])
