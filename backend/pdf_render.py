"""Render an eCH-0196 ``TaxStatement`` to the official PDF with PDF417 barcodes.

The barcode PDF is the format most cantonal tax-declaration tools scan on
import.  Rendering is delegated to ``opensteuerauszug``'s reportlab-based
renderer, which lays out the securities/bank tables and appends the eCH-0196
macro-PDF417 barcode pages that encode the (zlib-compressed) XML.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from opensteuerauszug.model.ech0196 import TaxStatement


class PdfRenderError(RuntimeError):
    """Raised when the barcode PDF could not be produced."""


def render_pdf(statement: TaxStatement, language: str = "de") -> bytes:
    """Return the eCH-0196 barcode PDF for ``statement`` as bytes.

    ``statement.id`` must already be a valid 31-char eCH-0196 id (the builder
    generates one); the renderer reads the custodian clearing number from it.
    """
    # Imported lazily: pulls in reportlab/PIL/pdf417gen only when a PDF is asked
    # for, keeping the CSV/XML path lightweight.
    try:
        from opensteuerauszug.render.render import render_tax_statement
    except Exception as exc:  # pragma: no cover - import/env issue
        raise PdfRenderError(f"PDF renderer unavailable: {exc}") from exc

    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "statement.pdf"
        try:
            render_tax_statement(statement, out_path, language=language)
        except Exception as exc:  # pragma: no cover - surfaces as HTTP 500 detail
            raise PdfRenderError(f"Could not render the barcode PDF: {exc}") from exc
        data = out_path.read_bytes()

    if not data.startswith(b"%PDF"):
        raise PdfRenderError("Renderer did not produce a valid PDF.")
    return data
