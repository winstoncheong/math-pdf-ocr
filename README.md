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

### Access from other devices on your network

Bind to `0.0.0.0` to accept connections from your LAN:

```bash
uv run python run.py --host 0.0.0.0 [--port nnnn]
```

Then connect from another device using your machine's LAN IP, e.g. `http://<your-lan-ip>:<port>`.

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

### PDF View
- Upload or open PDFs by file path
- Navigate pages, jump to page number
- Select any region on a page to OCR it
- Scrolling memory management — only keeps ~40 pages loaded at a time (frees decoded images for distant pages)
- Backend LRU cache (30 entries) — re-visiting recently viewed pages avoids re-render

### Image OCR
- Switch to the **Image OCR** tab to paste (Ctrl+V), drag & drop, or upload a screenshot
- Runs the full image through the selected OCR engine
- Results appear inline and in the shared results panel
- Useful for quick one-off OCR from screenshots, photos, or cropped regions

### Results
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
  pdf_utils.py     PyMuPDF rendering, region extraction, LRU page cache
  config.py        App configuration
frontend/
  index.html       Page layout, tabs, and modals
  app.js           UI logic, KaTeX rendering, state persistence, page windowing
  style.css        Dark theme styles
test-data/         Test images and expected LaTeX
test-results/      Test run logs (gitignored)
math-pdf-ocr.service  systemd user service for production deployment
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/upload` | Upload a PDF |
| GET | `/files` | List uploaded files |
| POST | `/open/{file_id}` | Reopen a previous file |
| POST | `/open-path` | Open PDF by server path |
| GET | `/info` | Active PDF info |
| GET | `/page/{page_num}` | Render page as PNG |
| POST | `/ocr` | OCR a region on a page |
| POST | `/api/ocr-image` | OCR an uploaded image (screenshot) |
| GET | `/backends` | List available OCR engines |
| POST | `/save-test` | Save a test case |

## Dependencies

- Python >=3.11 (managed with `uv`)
- FastAPI, uvicorn, PyMuPDF, Pillow
- Optional: texify, pix2tex, Ollama
