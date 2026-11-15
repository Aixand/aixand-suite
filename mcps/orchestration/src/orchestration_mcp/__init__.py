"""Portable orchestration; managers and application integrations are optional."""

__version__ = "0.1.0a2"
# Authenticated application operation protocol for captured tool contracts.
PROTOCOL = "aixand-suite/broker-1"

__all__ = [
    "LocalBackend",
    "Host",
    "RemoteBackend",
    "OrchestrationError",
]


def __getattr__(name):
    import importlib

    exports = {
        "LocalBackend": ("backend", "LocalBackend"),
        "Host": ("broker", "Host"),
        "RemoteBackend": ("broker", "RemoteBackend"),
        "OrchestrationError": ("errors", "OrchestrationError"),
    }
    if name not in exports:
        raise AttributeError(name)
    module, attribute = exports[name]
    value = getattr(importlib.import_module("." + module, __name__), attribute)
    globals()[name] = value
    return value
