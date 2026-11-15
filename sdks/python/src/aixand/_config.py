from dataclasses import dataclass
import math
from pathlib import Path


def seconds(value, name, *, zero=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value < 0 or (value == 0 and not zero)):
        raise ValueError(f"{name} must be finite and {'nonnegative' if zero else 'positive'}")
    return value


@dataclass(frozen=True)
class CarrierConfig:
    """External service by default; private() opts into an owned local service.

    Auto-provisioning uses Carrier's local administrative CLI, so database must
    refer to the same database served by url. Remote services need preprovisioned
    credentials (see messaging.mailbox and agents.spawn).
    """
    url: str = "http://127.0.0.1:8765"
    database: str | Path | None = None
    mode: str = "external"

    def __post_init__(self):
        if self.mode not in {"external", "private"}:
            raise ValueError("Carrier mode must be 'external' or 'private'")

    @classmethod
    def private(cls):
        """Start an isolated loopback service lazily; stop it when the scope closes."""
        return cls(mode="private")
