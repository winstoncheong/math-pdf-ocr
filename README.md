# Math PDF OCR

A web-based PDF viewer with math-aware OCR. Select a region on any page, and the app transcribes equations and text to LaTeX.

## Quick start

```bash
# Install
uv sync
uv sync --extra texify   # or --extra pix2tex

# Run
uv run python run.py --reload --open
```

Server runs at `http://127.0.0.1:8000`.

## OCR engines

| Engine | Type | Install |
|--------|------|---------|
| **texify** (default) | Local ML model | `uv sync --extra texify` |
| pix2tex | Local ML model | `uv sync --extra pix2tex` |
| ollama/glm-ocr | Ollama API | `ollama pull glm-ocr` |
| ollama/qwen3-vl:8b | Ollama API | `ollama pull qwen3-vl:8b` |
| ollama/llava | Ollama API | `ollama pull llava` |

Ollama engines need a running Ollama server at `127.0.0.1:11434`.

## Features

- Upload or open PDFs by file path
- Navigate pages, jump to page number
- Select any region on a page to OCR it
- LaTeX output rendered inline with KaTeX
- Toggle between raw LaTeX and rendered view
- Copy LaTeX to clipboard
- **Resend** — re-run the same crop with a different engine
- **Create test** — save a region + expected output as a test case
- DPI controls for page rendering and OCR extraction
- Recent files and last-opened PDF restored on startup
- State persisted across page refreshes (engine, DPI, results)

## Testing

```bash
# Run all tests against all available engines
uv run python test_runner.py

# Specific engine(s)
uv run python test_runner.py texify ollama/llava

# Custom similarity threshold (default 0.85)
uv run python test_runner.py texify --threshold=0.7
```

Test cases live in `test-data/` as `<name>.png` + `<name>.tex` pairs. Create them from the web UI using the **Create test** button on any OCR result. Results are logged to `test-results/`.

## Project structure

```
backend/
  main.py          FastAPI app, endpoints, KaTeX fixup
  ocr_engine.py    OCR engine implementations
  pdf_utils.py     PyMuPDF rendering and region extraction
  config.py        App configuration
frontend/
  index.html       Page layout and modal
  app.js           UI logic, KaTeX rendering, state persistence
  style.css        Dark theme styles
test-data/         Test images and expected LaTeX
test-results/      Test run logs (gitignored)
```

## Dependencies

- Python >=3.11 (managed with `uv`)
- FastAPI, uvicorn, PyMuPDF, Pillow
- Optional: texify, pix2tex, Ollama
