from collections import OrderedDict
from pathlib import Path

import fitz
from PIL import Image, ImageEnhance

_render_cache: OrderedDict = OrderedDict()
PAGE_CACHE_SIZE = 30


def _cache_key(pdf_path: Path, page_num: int, dpi: int) -> tuple:
    return (str(pdf_path), page_num, dpi)


def render_page(pdf_path: Path, page_num: int, dpi: int = 200) -> tuple[Image.Image, tuple[int, int, int, int]]:
    key = _cache_key(pdf_path, page_num, dpi)
    if key in _render_cache:
        _render_cache.move_to_end(key)
        return _render_cache[key]

    doc = fitz.open(pdf_path)
    page = doc[page_num]
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    bbox = (0, 0, pix.width, pix.height)
    doc.close()

    if len(_render_cache) >= PAGE_CACHE_SIZE:
        _render_cache.popitem(last=False)
    _render_cache[key] = (img, bbox)

    return img, bbox


def clear_page_cache():
    _render_cache.clear()


def extract_region(
    pdf_path: Path,
    page_num: int,
    x1: int, y1: int, x2: int, y2: int,
    render_dpi: int = 200,
    ocr_dpi: int = 400,
) -> Image.Image:
    doc = fitz.open(pdf_path)
    page = doc[page_num]

    render_zoom = render_dpi / 72
    left = min(x1, x2) / render_zoom
    top = min(y1, y2) / render_zoom
    right = max(x1, x2) / render_zoom
    bottom = max(y1, y2) / render_zoom
    pdf_rect = fitz.Rect(left, top, right, bottom)

    ocr_zoom = ocr_dpi / 72
    mat = fitz.Matrix(ocr_zoom, ocr_zoom)
    pix = page.get_pixmap(matrix=mat, clip=pdf_rect)
    doc.close()

    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.4)
    enhancer = ImageEnhance.Sharpness(img)
    img = enhancer.enhance(1.3)

    return img


def count_pages(pdf_path: Path) -> int:
    doc = fitz.open(pdf_path)
    n = doc.page_count
    doc.close()
    return n


def get_bookmarks(pdf_path: Path) -> list[dict]:
    doc = fitz.open(pdf_path)
    toc = doc.get_toc(simple=True)
    doc.close()
    return [{"level": entry[0], "title": entry[1], "page": entry[2]} for entry in toc]
