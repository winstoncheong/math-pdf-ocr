import base64
import io
import json
import logging
import urllib.request
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


class TexifyEngine(OCREngine):
    MODEL_ID = "vikp/texify"

    def __init__(self):
        self._model = None
        self._processor = None
        self._loaded = False

    @property
    def name(self) -> str:
        return "texify"

    @property
    def available(self) -> bool:
        if self._loaded:
            return True
        try:
            import transformers  # noqa: F401
            import texify  # noqa: F401
            return True
        except ImportError:
            return False

    def _load(self):
        if self._loaded:
            return
        from texify.model.model import GenerateVisionEncoderDecoderModel
        from texify.model.processor import load_processor
        logger.info("Loading texify model from HuggingFace...")
        self._model = GenerateVisionEncoderDecoderModel.from_pretrained(self.MODEL_ID)
        self._processor = load_processor()
        self._loaded = True
        logger.info("Texify model loaded")

    def recognize(self, image: Image.Image) -> str:
        self._load()
        import torch
        from texify.output import postprocess, replace_katex_invalid
        images = [image.convert("RGB")]
        encodings = self._processor(
            images=images, return_tensors="pt", add_special_tokens=False
        )
        pixel_values = encodings["pixel_values"].to(self._model.dtype)
        pixel_values = pixel_values.to(self._model.device)
        with torch.no_grad():
            generated_ids = self._model.generate(
                pixel_values=pixel_values,
                max_new_tokens=384,
                decoder_start_token_id=self._processor.tokenizer.bos_token_id,
            )
        text = self._processor.tokenizer.decode(
            generated_ids[0], skip_special_tokens=True
        )
        text = postprocess(text)
        text = replace_katex_invalid(text)
        return text.strip()


OLLAMA_DEFAULT_MODEL = "llava"
OLLAMA_PROMPT = (
    "Transcribe all visible text and mathematical notation from this image exactly as shown. "
    "Render math expressions as LaTeX ($...$ for inline, $$...$$ for display). "
    "Preserve line breaks between paragraphs. "
    "Respond ONLY with the transcription — no explanations, no preambles, no apologies."
)


class OllamaEngine(OCREngine):
    def __init__(self, model: str = OLLAMA_DEFAULT_MODEL):
        self._model_name = model
        self._base_url = "http://127.0.0.1:11434"
        self._checked = False
        self._available = False

    @property
    def name(self) -> str:
        return f"ollama/{self._model_name}"

    @property
    def available(self) -> bool:
        if self._checked:
            return self._available
        self._checked = True
        try:
            req = urllib.request.Request(
                f"{self._base_url}/api/tags",
                method="GET",
                headers={"Accept": "application/json"},
            )
            resp = urllib.request.urlopen(req, timeout=3)
            if resp.status != 200:
                return False
            data = json.loads(resp.read())
            models = [m["name"] for m in data.get("models", [])]
            # accept name with or without :latest
            ok = any(m.split(":")[0] == self._model_name or m == self._model_name for m in models)
            if not ok:
                logger.warning("Ollama model '%s' not found. Available: %s", self._model_name, models)
            self._available = ok
            return ok
        except Exception as e:
            logger.warning("Ollama not available: %s", e)
            return False

    def recognize(self, image: Image.Image) -> str:
        img = image.convert("RGB")
        max_dim = 800
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img = img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode()

        body = json.dumps({
            "model": self._model_name,
            "prompt": OLLAMA_PROMPT,
            "images": [b64],
            "stream": False,
        }).encode()
        req = urllib.request.Request(
            f"{self._base_url}/api/generate",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=300)
        result = json.loads(resp.read())
        return (result.get("response", "") or "").strip()


_engines: dict[str, OCREngine] = {}


def get_engine(name: str) -> OCREngine | None:
    if name not in _engines:
        if name == "pix2tex":
            _engines[name] = Pix2texEngine()
        elif name == "nougat":
            _engines[name] = NougatEngine()
        elif name == "texify":
            _engines[name] = TexifyEngine()
        elif name == "ollama":
            _engines[name] = OllamaEngine()
        elif name.startswith("ollama/"):
            model = name.split("/", 1)[1]
            _engines[name] = OllamaEngine(model=model)
        else:
            return None
    return _engines[name]


OLLAMA_MODELS = ["llava", "glm-ocr", "qwen3-vl:8b"]


def list_engines() -> list[dict]:
    result = []
    for name in ("pix2tex", "texify"):
        eng = get_engine(name)
        if eng is not None:
            result.append({"name": eng.name, "available": eng.available})
    for model in OLLAMA_MODELS:
        eng = get_engine(f"ollama/{model}")
        result.append({"name": eng.name, "available": eng.available})
    return result
