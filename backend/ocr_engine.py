import logging
from abc import ABC, abstractmethod

from PIL import Image

logger = logging.getLogger(__name__)


class OCREngine(ABC):
    @abstractmethod
    def recognize(self, image: Image.Image) -> str:
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def available(self) -> bool:
        ...


class Pix2texEngine(OCREngine):
    def __init__(self):
        self._model = None
        self._loaded = False

    @property
    def name(self) -> str:
        return "pix2tex"

    @property
    def available(self) -> bool:
        if self._loaded:
            return True
        try:
            import pix2tex  # noqa: F401
            logger.info("pix2tex import OK at %s", pix2tex.__file__)
            return True
        except ImportError as e:
            logger.warning("pix2tex import failed: %s", e)
            return False

    def _load(self):
        if self._loaded:
            return
        from pix2tex.cli import LatexOCR
        logger.info("Loading pix2tex model...")
        self._model = LatexOCR()
        self._loaded = True
        logger.info("pix2tex model loaded")

    def recognize(self, image: Image.Image) -> str:
        self._load()
        return self._model(image)


class NougatEngine(OCREngine):
    def __init__(self):
        self._model = None
        self._processor = None
        self._loaded = False

    @property
    def name(self) -> str:
        return "nougat"

    @property
    def available(self) -> bool:
        if self._loaded:
            return True
        try:
            import nougat  # noqa: F401
            return True
        except ImportError:
            return False

    def _load(self):
        if self._loaded:
            return
        from nougat import NougatModel
        from nougat.utils.checkpoint import get_checkpoint
        from transformers import BatchFeature
        logger.info("Loading Nougat model...")
        checkpoint = get_checkpoint()
        self._model = NougatModel.from_pretrained(checkpoint)
        self._model.to("cpu")
        self._processor = self._model.processor
        self._loaded = True
        logger.info("Nougat model loaded")

    def recognize(self, image: Image.Image) -> str:
        self._load()
        import torch
        pixel_values = self._processor(images=image.convert("RGB"), return_tensors="pt").pixel_values
        with torch.no_grad():
            outputs = self._model.generate(pixel_values.to("cpu"))
        return self._processor.batch_decode(outputs, skip_special_tokens=True)[0]


_engines: dict[str, OCREngine] = {}


def get_engine(name: str) -> OCREngine | None:
    if name not in _engines:
        if name == "pix2tex":
            _engines[name] = Pix2texEngine()
        elif name == "nougat":
            _engines[name] = NougatEngine()
        else:
            return None
    return _engines[name]


def list_engines() -> list[dict]:
    result = []
    for name in ("pix2tex", "nougat"):
        eng = get_engine(name)
        if eng is not None:
            result.append({"name": eng.name, "available": eng.available})
    return result
