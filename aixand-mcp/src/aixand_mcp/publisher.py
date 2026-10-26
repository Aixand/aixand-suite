"""Retain the historical Suite publisher identity for existing callers."""
import sys
from orchestration_mcp.publisher import bundle
from orchestration_mcp.publisher import publish as _publish, accepted as _accepted

def publish(manager, contracts):
    return _publish(manager, contracts, publisher_id='aixand-suite')

def accepted(manager, group):
    return _accepted(manager, group, publisher_id='aixand-suite')
