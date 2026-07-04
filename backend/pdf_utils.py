from pathlib import Path

import fitz
from PIL import Image


def render_page(pdf_path: Path, page_num: int, dpi: int = 200) -> tuple[Image.Image, tuple[int, int, int, int]]:
    doc = fitz.open(pdf_path)
    page = doc[page_num]
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    bbox = (0, 0, pix.width, pix.height)
    doc.close()
    return img, bbox


def extract_region(
    pdf_path: Path, page_num: int, x1: int, y1: int, x2: int, y2: int, dpi: int = 200
) -> Image.Image:
    doc = fitz.open(pdf_path)
    page = doc[page_num]
    zoom = dpi / 72
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    doc.close()
    left, top = min(x1, x2), min(y1, y2)
    right, bottom = max(x1, x2), max(y1, y2)
    left = max(0, left)
    top = max(0, top)
    right = min(img.width, right)
    bottom = min(img.height, bottom)
    return img.crop((left, top, right, bottom))


def count_pages(pdf_path: Path) -> int:
    doc = fitz.open(pdf_path)
    n = doc.page_count
    doc.close()
    return n
