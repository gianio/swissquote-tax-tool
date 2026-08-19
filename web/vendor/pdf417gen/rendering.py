# Trimmed for Pyodide (browser): no PIL. Only geometry helpers are kept; the
# barcode is drawn in JavaScript from the module coordinates.
from typing import List, Tuple


def barcode_size(codes: List[List[int]]) -> Tuple[int, int]:
    num_rows = len(codes)
    num_cols = len(codes[0])
    width = num_cols * 17 + 1
    height = num_rows
    return width, height


def modules(codes: List[List[int]]):
    """Yield black barcode modules as (x, y) tuples."""
    for row_id, row in enumerate(codes):
        col_id = 0
        for value in row:
            for digit in format(value, 'b'):
                if digit == "1":
                    yield col_id, row_id
                col_id += 1
