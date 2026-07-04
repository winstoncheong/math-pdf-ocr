# AGENTS.md

## Quick start

```bash
# Run dev server with auto-reload
uv run python run.py --reload

# Open browser on launch
uv run python run.py --reload --open
```

Server runs at `http://127.0.0.1:8000` by default.

## Architecture

- **Backend**: FastAPI app at `backend/main.py` (`backend.main:app`). Entry point for uvicorn.
- **Frontend**: Vanilla JS/HTML/CSS in `frontend/`. Mounted as static files at `/` by FastAPI.
- **OCR engines**: `backend/ocr_engine.py` — abstract `OCREngine` base class with implementations:
  - `pix2tex` — local ML model, requires `uv sync --extra pix2tex`
  - `texify` — local ML model, requires `uv sync --extra texify`
  - `ollama/llava`, `ollama/glm-ocr`, `ollama/qwen3-vl:8b` — calls local Ollama API at `127.0.0.1:11434`
- **PDF rendering**: `backend/pdf_utils.py` uses PyMuPDF (`fitz`). Uploaded PDFs stored in `uploads/` (gitignored).
- **KaTeX fixup**: `_fix_katex()` in `main.py` strips KaTeX-incompatible syntax (`\operatorname*`, `\Bigg`, `\tag`, `\mbox`) from all engine outputs before returning.

## Dependencies & Python

- Requires Python >=3.11. Managed with `uv`.
- Install: `uv sync`
- OCR backends are optional extras: `uv sync --extra pix2tex` or `uv sync --extra texify`
- Ollama backends need no extra Python packages — just a running Ollama server with the model available.

## Testing

```bash
# Run all tests against all available engines
uv run python test_runner.py

# Run against specific engine(s)
uv run python test_runner.py texify ollama/llava

# Custom similarity threshold (default 0.85)
uv run python test_runner.py texify --threshold=0.7
```

- Test images go in `test-data/` as `<name>.png` + `<name>.tex` pairs.
- Results logged to `test-results/results_<timestamp>.json`.
- Validation uses `difflib` string similarity on normalized LaTeX (whitespace, braces, matrix envs, spacing commands stripped).

## Key facts

- `uploads/` directory is gitignored — created at startup if missing.
- `test-results/` directory is gitignored.
- Frontend uses KaTeX (CDN) for LaTeX rendering in results.
- OCR coordinates are converted from display-space to rendered-image-space in `frontend/app.js` using `renderedW/displayW` scaling.
- Backend uses in-memory state (`_uploads` dict, `_active_pdf` dict) — no database. Restarting clears uploaded file references (files remain on disk).
- Recent files persisted to `uploads/recent.json`. Last-opened PDF persisted to `uploads/last_active.json` and restored on startup.
