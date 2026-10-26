"""Shared state API retained for the recovery worker and existing consumers."""
import importlib.util
import os
from pathlib import Path
import sys

if importlib.util.find_spec('orchestration_mcp') is None:
    source = Path(os.environ.get('ORCHESTRATION_MCP_SOURCE') or Path(__file__).resolve().parents[3]/'manager-suites/orchestration-mcp/src')
    if source.is_dir():
        sys.path.insert(0, str(source))
from orchestration_mcp.compat import export
export(globals(), "state")
