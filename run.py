#!/usr/bin/env python3
import argparse
import logging
import sys
import webbrowser

import uvicorn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logging.getLogger("watchfiles.main").setLevel(logging.WARNING)


def main():
    parser = argparse.ArgumentParser(description="Math PDF OCR - web-based PDF viewer with math OCR")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to (default: 8000)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload on code changes")
    parser.add_argument("--open", action="store_true", help="Open browser automatically")
    args = parser.parse_args()

    if args.open:
        webbrowser.open(f"http://{args.host}:{args.port}")

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
