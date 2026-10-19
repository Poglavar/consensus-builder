#!/usr/bin/env python3
"""Report installed OCR/vision modules and PDF/OCR executable paths."""
import importlib
import shutil
import sys

MODULES = ("cv2", "numpy", "PIL")
BINARIES = ("pdfinfo", "pdftoppm", "pdftotext", "tesseract")
failed = False

for name in MODULES:
    try:
        module = importlib.import_module(name)
        version = getattr(module, "__version__", "available")
        print(f"module {name}: {version}")
    except Exception as error:
        failed = True
        print(f"module {name}: MISSING ({type(error).__name__})")

for name in BINARIES:
    path = shutil.which(name)
    print(f"binary {name}: {path or 'MISSING'}")
    failed |= path is None

if failed:
    sys.exit(1)
