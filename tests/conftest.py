import sys
from pathlib import Path

# Make the project root importable so ``import backend...`` works under pytest.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SAMPLE_CSV = ROOT / "sample_data" / "sample_swissquote.csv"
