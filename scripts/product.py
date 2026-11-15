#!/usr/bin/env python3
"""Suite-owned tools use the in-tree schema-2 installation engine."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    raise SystemExit(subprocess.call([sys.executable, '-B', ROOT / 'scripts/dev/cli.py',
        '--project', ROOT, *sys.argv[1:]]))
