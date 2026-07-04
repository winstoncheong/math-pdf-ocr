import io
import logging
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

_active_pdf: dict = {"path": None, "pages": 0}


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
    dest = config.upload_dir / f"{file_id}_{file.filename}"
    content = await file.read()
    if len(content) > config.max_upload_size_mb * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {config.max_upload_size_mb}MB limit")
    dest.write_bytes(content)
    pages = count_pages(dest)
    _active_pdf["path"] = dest
    _active_pdf["pages"] = pages
    return {"filename": file.filename, "pages": pages, "file_id": file_id}


@app.get("/info")
async def info():
    path = _get_active_pdf()
    return {"filename": path.name, "pages": _active_pdf["pages"]}


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
    return {"backends": list_engines()}


frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")
