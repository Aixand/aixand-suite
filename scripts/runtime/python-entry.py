"""Relocatable console scripts for the private bundled Python installation."""
from importlib.metadata import entry_points
import sys

name = sys.argv.pop(1)
matches = list(entry_points(group="console_scripts", name=name))
if len(matches) != 1:
    raise SystemExit(f"Bundled command {name!r} is unavailable or ambiguous")
sys.argv[0] = name
raise SystemExit(matches[0].load()())
