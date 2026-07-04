from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    upload_dir: Path = field(default_factory=lambda: Path("uploads"))
    render_dpi: int = 200
    host: str = "127.0.0.1"
    port: int = 8000
    default_backend: str = "pix2tex"
    max_upload_size_mb: int = 50
