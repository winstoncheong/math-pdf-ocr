import io
import json
import logging
import re
import sys
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .config import Config
from .pdf_utils import count_pages, extract_region, render_page
from .ocr_engine import get_engine, list_engines

logger = logging.getLogger(__name__)
config = Config()
app = FastAPI(title="Math PDF OCR")

_uploads: dict[str, dict] = {}
_active_pdf: dict = {"path": None, "pages": 0, "file_id": None}


def _recent_json_path() -> Path:
    return config.upload_dir / "recent.json"


def _last_active_json_path() -> Path:
    return config.upload_dir / "last_active.json"


def _save_recent():
    data = {}
    for fid, info in _uploads.items():
        data[fid] = {
            "path": str(info["path"]),
            "filename": info["filename"],
            "pages": info["pages"],
            "ts": info.get("ts", 0),
        }
    _recent_json_path().write_text(json.dumps(data, indent=2))


def _load_recent():
    path = _recent_json_path()
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load recent.json: %s", e)
        return
    for fid, info in data.items():
        file_path = Path(info["path"])
        if file_path.exists():
            _uploads[fid] = {
                "path": info["path"],
                "filename": info["filename"],
                "pages": info["pages"],
                "ts": info.get("ts", 0),
            }
        else:
            logger.info("Skipping missing file from recent: %s", info["path"])


def _save_last_active():
    if _active_pdf["file_id"] is None:
        return
    data = {"file_id": _active_pdf["file_id"]}
    _last_active_json_path().write_text(json.dumps(data))


def _load_last_active():
    path = _last_active_json_path()
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return
    fid = data.get("file_id")
    if fid and fid in _uploads:
        info = _uploads[fid]
        file_path = Path(info["path"])
        if file_path.exists():
            pages = count_pages(file_path)
            _active_pdf["path"] = file_path
            _active_pdf["pages"] = pages
            _active_pdf["file_id"] = fid


@app.on_event("startup")
async def startup():
    config.upload_dir.mkdir(parents=True, exist_ok=True)
    _load_recent()
    _load_last_active()


def _get_active_pdf():
    if _active_pdf["path"] is None:
        raise HTTPException(400, "No PDF uploaded. POST /upload first.")
    return _active_pdf["path"]


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files allowed")
    file_id = str(uuid.uuid4())[:8]
    dest = config.upload_dir / f"{file_id}.pdf"
    content = await file.read()
    if len(content) > config.max_upload_size_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {config.max_upload_size_mb}MB limit")
    dest.write_bytes(content)
    pages = count_pages(dest)
    _uploads[file_id] = {
        "path": str(dest),
        "filename": file.filename,
        "pages": pages,
        "ts": time.time(),
    }
    _active_pdf["path"] = dest
    _active_pdf["pages"] = pages
    _active_pdf["file_id"] = file_id
    _save_recent()
    _save_last_active()
    return {"filename": file.filename, "pages": pages, "file_id": file_id}


@app.get("/files")
async def list_files():
    items = []
    for fid, info in _uploads.items():
        items.append({
            "file_id": fid,
            "filename": info["filename"],
            "pages": info["pages"],
            "ts": info.get("ts", 0),
        })
    items.sort(key=lambda x: x["ts"], reverse=True)
    return {"files": items}


@app.post("/open/{file_id}")
async def open_file(file_id: str):
    if file_id not in _uploads:
        raise HTTPException(404, "File not found")
    info = _uploads[file_id]
    file_path = Path(info["path"])
    if not file_path.exists():
        raise HTTPException(410, "File no longer exists on disk")
    pages = count_pages(file_path)
    info["pages"] = pages
    _active_pdf["path"] = file_path
    _active_pdf["pages"] = pages
    _active_pdf["file_id"] = file_id
    _save_last_active()
    return {"filename": info["filename"], "pages": pages, "file_id": file_id}


@app.post("/open-path")
async def open_path(body: dict):
    file_path = Path(body.get("path", ""))
    if not file_path.is_absolute():
        raise HTTPException(400, "Path must be absolute")
    if not file_path.exists():
        raise HTTPException(404, "File not found")
    if not file_path.suffix.lower() == ".pdf":
        raise HTTPException(400, "Only PDF files allowed")

    file_id = str(uuid.uuid4())[:8]
    pages = count_pages(file_path)
    _uploads[file_id] = {
        "path": str(file_path),
        "filename": file_path.name,
        "pages": pages,
        "ts": time.time(),
    }
    _active_pdf["path"] = file_path
    _active_pdf["pages"] = pages
    _active_pdf["file_id"] = file_id
    _save_recent()
    _save_last_active()
    return {"filename": file_path.name, "pages": pages, "file_id": file_id}


@app.get("/info")
async def info():
    path = _get_active_pdf()
    fid = _active_pdf.get("file_id", "")
    return {"filename": path.name, "pages": _active_pdf["pages"], "file_id": fid}


@app.get("/page/{page_num}")
async def get_page(page_num: int, dpi: int = Query(default=200, ge=72, le=600)):
    path = _get_active_pdf()
    if page_num < 0 or page_num >= _active_pdf["pages"]:
        raise HTTPException(404, f"Page {page_num} not found. Pages: 0-{_active_pdf['pages'] - 1}")
    img, bbox = render_page(path, page_num, dpi=dpi)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


def _fix_katex(text: str) -> str:
    text = re.sub(r'\\operatorname\*', r'\\operatorname', text)
    text = re.sub(r'\\(?:Bigg?|bigg?)\{(.*?)\}', r'\1', text)
    text = re.sub(r'\\tag\{.*?\}', '', text)
    text = re.sub(r'\\quad\\mbox\{(.*?)\}', r'\1', text)
    text = re.sub(r'\\mbox\{(.*?)\}', r'\1', text)
    return text


@app.post("/ocr")
async def ocr_region(
    page_num: int,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    dpi: int = Query(default=200, ge=72, le=600),
    ocr_dpi: int = Query(default=0, ge=100, le=1200),
    backend: str = Query(default=""),
):
    path = _get_active_pdf()
    if page_num < 0 or page_num >= _active_pdf["pages"]:
        raise HTTPException(404, f"Page {page_num} not found")

    engine_name = backend or config.default_backend
    engine = get_engine(engine_name)
    if engine is None:
        raise HTTPException(400, f"Unknown backend '{engine_name}'")
    if not engine.available:
        raise HTTPException(400, f"Backend '{engine_name}' is not installed")

    actual_ocr_dpi = ocr_dpi if ocr_dpi > 0 else config.ocr_dpi
    crop = extract_region(path, page_num, x1, y1, x2, y2, render_dpi=dpi, ocr_dpi=actual_ocr_dpi)
    latex = engine.recognize(crop)
    latex = _fix_katex(latex)
    return {"latex": latex, "backend": engine_name, "ocr_dpi": actual_ocr_dpi}


@app.get("/backends")
async def backends():
    engines = list_engines()
    try:
        import pix2tex as _pt
        px_path = _pt.__file__
    except ImportError:
        px_path = None
    return {
        "backends": engines,
        "debug": {
            "sys_executable": sys.executable,
            "python": sys.version,
            "pix2tex_path": px_path,
        },
    }


frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
