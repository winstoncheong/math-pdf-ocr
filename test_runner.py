"""Run OCR tests from test-data/ against all available engines and log results."""

import difflib
import json
import re
import sys
import time
from pathlib import Path

from PIL import Image

from backend.ocr_engine import get_engine, list_engines

TEST_DIR = Path(__file__).parent / "test-data"
RESULTS_DIR = Path(__file__).parent / "test-results"

SIMILARITY_THRESHOLD = 0.85


def _normalize_latex(s: str) -> str:
    """Normalize LaTeX for fuzzy comparison — strip cosmetic differences."""
    s = s.strip()
    # Remove display/inline math delimiters
    s = re.sub(r'^\$\$|\$\$$', '', s)
    s = re.sub(r'^\$|\$$', '', s)
    # Remove \left, \right, \big, \Big, \bigg, \Bigg and variants
    s = re.sub(r'\\(?:left|right|big|Big|bigg|Bigg)(?:|[()[\]{}|.])', '', s)
    # Normalize \middle| to just |
    s = s.replace('\\middle|', '|')
    # Remove spacing commands
    s = re.sub(r'\\[,;:!>\ ]', '', s)
    s = re.sub(r'\\quad\\mbox\{(.*?)\}', r'\1', s)
    # Remove \displaystyle, \textstyle, etc.
    s = re.sub(r'\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle)', '', s)
    # Normalize matrix environments: array, matrix, pmatrix, bmatrix -> matrix
    s = re.sub(r'\\begin\{(array|pmatrix|bmatrix)\}', r'\\begin{matrix}', s)
    s = re.sub(r'\\end\{(array|pmatrix|bmatrix)\}', r'\\end{matrix}', s)
    # Remove array column specs like {l l} or {|l|l|}
    s = re.sub(r'\\begin\{matrix\}\{[^}]*\}', r'\\begin{matrix}', s)
    # Collapse multiple braces: {{x}} -> x, {{{x}}} -> x
    while re.search(r'\{\{+([^{}]+)\}\}+', s):
        s = re.sub(r'\{\{+([^{}]+)\}\}+', r'\1', s)
    # Remove empty groups
    s = s.replace('{}', '')
    # Remove all whitespace
    s = re.sub(r'\s+', '', s)
    # Lowercase everything
    s = s.lower()
    return s


def latex_similarity(actual: str, expected: str) -> float:
    """Compare two LaTeX strings, returning 0.0–1.0 similarity."""
    a = _normalize_latex(actual)
    e = _normalize_latex(expected)
    if a == e:
        return 1.0
    return difflib.SequenceMatcher(None, a, e).ratio()


def discover_tests():
    tests = []
    for img_path in sorted(TEST_DIR.glob("*.png")):
        tex_path = img_path.with_suffix(".tex")
        if not tex_path.exists():
            print(f"  SKIP {img_path.name} (no .tex expected output)")
            continue
        expected = tex_path.read_text(encoding="utf-8").strip()
        tests.append((img_path, expected))
    return tests


def run_tests(engines=None, threshold=SIMILARITY_THRESHOLD):
    RESULTS_DIR.mkdir(exist_ok=True)
    tests = discover_tests()
    if not tests:
        print("No tests found in test-data/")
        return

    available = list_engines()
    if engines:
        available = [e for e in available if e["name"] in engines and e["available"]]
    else:
        available = [e for e in available if e["available"]]

    if not available:
        print("No available engines to test")
        return

    print(f"Found {len(tests)} test(s), {len(available)} engine(s)")
    print(f"Similarity threshold: {threshold}\n")

    all_results = []

    for engine_info in available:
        engine_name = engine_info["name"]
        engine = get_engine(engine_name)
        print(f"=== {engine_name} ===")

        for img_path, expected in tests:
            img = Image.open(img_path).convert("RGB")
            print(f"  {img_path.name} ... ", end="", flush=True)

            t0 = time.time()
            try:
                actual = engine.recognize(img)
                elapsed = time.time() - t0
            except Exception as e:
                actual = f"ERROR: {e}"
                elapsed = time.time() - t0

            sim = latex_similarity(actual, expected)
            passed = sim >= threshold
            status = "PASS" if passed else "FAIL"
            print(f"{status} sim={sim:.2f} ({elapsed:.2f}s)")

            if not passed:
                print(f"    Expected: {expected}")
                print(f"    Actual:   {actual}")

            result = {
                "engine": engine_name,
                "test": img_path.name,
                "expected": expected,
                "actual": actual,
                "similarity": round(sim, 4),
                "passed": passed,
                "time_s": round(elapsed, 3),
            }
            all_results.append(result)

        print()

    # Write results
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_file = RESULTS_DIR / f"results_{ts}.json"
    out_file.write_text(json.dumps(all_results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Results written to {out_file}")

    # Summary
    total = len(all_results)
    passed = sum(1 for r in all_results if r["passed"])
    print(f"\nSummary: {passed}/{total} passed (threshold={threshold})")


if __name__ == "__main__":
    engine_filter = set()
    threshold = SIMILARITY_THRESHOLD
    for arg in sys.argv[1:]:
        if arg.startswith("--threshold="):
            threshold = float(arg.split("=", 1)[1])
        else:
            engine_filter.add(arg)
    run_tests(engine_filter or None, threshold)
