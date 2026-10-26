"""Prepare a disposable manager home for API/browser integration tests."""
import json
from pathlib import Path
import shutil
import sys
import agent_manager

base = Path(sys.argv[1]).resolve()
base.mkdir(parents=True, exist_ok=True)
provider = base / "offline-provider"
shutil.copyfile(Path(__file__).with_name("offline_provider.py"), provider)
provider.chmod(0o700)
config = base / "providers.toml"
config.write_text("\n".join([
    "[providers.codex]", f"executable = {json.dumps(str(provider))}",
    f"native_home = {json.dumps(str(base / 'native-codex'))}",
    'home_env = "TEST_AGENT_HOME"', 'run_args = []', 'login_args = ["login"]',
    'budget_args = ["app-server"]', 'budget_timeout = 1',
    "[providers.opencode]", f"executable = {json.dumps(str(provider))}",
    f"native_home = {json.dumps(str(base / 'native-opencode'))}",
]))
manager = agent_manager.Manager("codex", config=config, root=base / "manager")
manager.new("work", "personal", True)
manager.new("review", "company", True)
print(json.dumps({"config": str(config), "home": str(base / "manager"), "cwd": str(base)}))
