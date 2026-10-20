"""Export the Python app's effective settings as JSON, for import into v2.

The Python app never reads data/settings.json directly: load_settings()
merges it with built-in defaults and refreshes some credentials based on
shared_people_credentials_version. Using that same function guarantees v2
imports exactly the users, permissions and settings the old app shows.

Usage (repo root):
    .venv/Scripts/python v2/tools/export_settings.py [path/to/settings.json] > settings-export.json
Without a path, it exports the defaults (as if no settings.json existed).
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

sys.path.insert(0, os.getcwd())

from app import config  # noqa: E402

if len(sys.argv) > 1:
    config.SETTINGS_PATH = pathlib.Path(sys.argv[1])
else:
    # load_settings() writes the defaults to the path when it does not exist,
    # so point it at a fresh temporary file rather than data/settings.json.
    import tempfile

    config.SETTINGS_PATH = pathlib.Path(tempfile.mkdtemp()) / "settings.json"

print(json.dumps(config.load_settings(), indent=1, ensure_ascii=False))
