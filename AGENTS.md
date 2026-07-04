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
- **OCR engines**: `backend/ocr_engine.py` — abstract `OCREngine` base class with three implementations:
  - `pix2tex` — local ML model, requires `pip install pix2tex[api]`
  - `nougat` — local ML model, requires `pip install nougat-ocr`
  - `ollama/llava` (default) — calls local Ollama API at `127.0.0.1:11434`, must have `llava` model pulled
- **PDF rendering**: `backend/pdf_utils.py` uses PyMuPDF (`fitz`). Uploaded PDFs stored in `uploads/` (gitignored).

## Dependencies & Python

- Requires Python >=3.11. Managed with `uv`.
- Install: `uv sync`
- OCR backends are optional extras: `uv sync --extra pix2tex` or `uv sync --extra nougat`
- Ollama backend needs no extra Python packages — just a running Ollama server with the model available.

## Key facts

- No test suite, linter, or formatter configured.
- No CI pipeline.
- `uploads/` directory is gitignored — created at startup if missing.
- Frontend uses KaTeX (CDN) for LaTeX rendering in results.
- OCR coordinates are converted from display-space to rendered-image-space in `frontend/app.js` using `renderedW/displayW` scaling.
- Backend uses in-memory state (`_uploads` dict, `_active_pdf` dict) — no database. Restarting clears uploaded file references (files remain on disk).
