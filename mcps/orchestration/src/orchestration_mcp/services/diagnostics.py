"""Bounded local exception locations without messages, locals, or request data."""
import json
import os
from pathlib import Path
import time
import traceback
import uuid


def record(error, *, operation, provider=None, backend=None):
    identifier = uuid.uuid4().hex
    # Exception text, arguments, source lines and absolute paths can contain
    # credentials or prompts. Keep only the class and stack locations.
    value = dict(id=identifier, at=int(time.time() * 1000), operation=operation,
                 provider=provider, backend=backend, exception=type(error).__name__,
                 frames=[dict(file=Path(frame.filename).name, function=frame.name, line=frame.lineno)
                         for frame in traceback.extract_tb(error.__traceback__)[-20:]])
    try:
        root = Path(os.environ.get('AGENTS_STATE_DIR') or
                    Path(os.environ.get('XDG_STATE_HOME', '~/.local/state')).expanduser() / 'aixand' / 'agents') / 'diagnostics'
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = root / (identifier + '.json')
        with path.open('x', encoding='utf-8') as handle:
            if os.name != 'nt':
                os.chmod(path, 0o600)
            json.dump(value, handle)
        for old in sorted(root.glob('*.json'), key=lambda item: item.stat().st_mtime, reverse=True)[100:]:
            old.unlink(missing_ok=True)
    except OSError:
        # Reporting must never replace the original operation's result.
        pass
    return identifier
