from pathlib import Path

import fitz
from PIL import Image, ImageEnhance


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
