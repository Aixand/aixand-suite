"""Run one accepted operation in a retained PTY; commit a private completion receipt."""
import asyncio
import json
from pathlib import Path
import signal
import sys
import time

from agent_manager import Error, Manager
from agent_manager.errors import BusyError
from agent_manager.storage.locks import locks
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from application.services.agent_operations import read, write


def perform(spec):
    manager = Manager(spec['provider'], config=spec.get('config'), root=spec.get('home'))
    return manager.perform_provider_operation(spec, progress=lambda value: write(
        Path(spec['operationRoot']) / 'progress' / (spec['id'] + '.json'), value))


def main():
    root, identifier = Path(sys.argv[1]), sys.argv[2]
    spec = read(root / "specs" / (identifier + ".json"))
    spec["operationRoot"] = str(root)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(130))
    code = 0
    try:
        with locks(root / ".locks", "worker-" + identifier):
            if read(root / "results" / (identifier + ".json")):
                return
            result = perform(spec)
        receipt = {"status": "succeeded", "message": "Native login command completed." if spec["kind"] == "profile-login" else
            "Native login status checked." if spec["kind"] == "check-profile" else "Provider operation completed.", "result": result}
        if result.get('terminalCommand') and not result['terminalCommand'].get('ready'):
            receipt['message'] = 'CLI installed; terminal command setup needs attention. Use Repair terminal command.'
        elif spec['kind']=='setup-command':
            receipt['message'] = 'Terminal command verified. Open a new terminal window to use it.'
    except (KeyboardInterrupt, SystemExit):
        code = 130
        receipt = {"status": "cancelled", "message": "Operation cancelled.", "result": {}}
    except BusyError:
        code = 1
        receipt = dict(status='failed', message='This profile became busy before sign-in could start. No login was launched. Finish or close its remaining sessions, then retry.', result=dict(code='profile_busy', retryable=True))
    except Exception as error:
        code = 1
        # Provider exceptions and terminal output can contain credential details.
        print(f"Operation failed: {error}", file=sys.stderr, flush=True)
        receipt = {"status": "failed", "message": "The operation failed. Check its terminal for details.",
                   "result": {"verification": "failed"} if spec["kind"] == "check-profile" else {}}
    receipt.update(exitCode=code, updatedAt=time.time() * 1000)
    write(root / "results" / (identifier + ".json"), receipt)
    print(receipt["message"], flush=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
