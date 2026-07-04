import io
import logging
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


@app.on_event("startup")
async def startup():
    config.upload_dir.mkdir(parents=True, exist_ok=True)


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
        "path": dest,
        "filename": file.filename,
        "pages": pages,
        "ts": time.time(),
    }
    _active_pdf["path"] = dest
    _active_pdf["pages"] = pages
    _active_pdf["file_id"] = file_id
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
    if not info["path"].exists():
        raise HTTPException(410, "File no longer exists on server")
    pages = count_pages(info["path"])
    info["pages"] = pages
    _active_pdf["path"] = info["path"]
    _active_pdf["pages"] = pages
    _active_pdf["file_id"] = file_id
    return {"filename": info["filename"], "pages": pages, "file_id": file_id}


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


@app.post("/ocr")
async def ocr_region(
    page_num: int,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    dpi: int = Query(default=200, ge=72, le=600),
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

    crop = extract_region(path, page_num, x1, y1, x2, y2, dpi=dpi)
    latex = engine.recognize(crop)
    return {"latex": latex, "backend": engine_name}


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
