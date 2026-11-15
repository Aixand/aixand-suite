"""Build a dependency-free receiver download; excludes the Suite sender and tests."""
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
destination = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist/aixand-connect.pyz"
destination.parent.mkdir(parents=True, exist_ok=True)
files = {"__main__.py": b"from aixand_connect.companion import main\nmain()\n"}
files['LICENSE'] = (root / 'LICENSE').read_bytes()
for name in ("__init__.py", "protocol.py", "companion.py", "codex.py", "snapshot.py", "project_workspace.py", "managers.py", "manager_helper.py", "profile_selection.py"):
    files["aixand_connect/" + name] = (root / "aixand_connect" / name).read_bytes()
with ZipFile(destination, "w") as bundle:
    for name, content in files.items():
        info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        bundle.writestr(info, content)
print(f"Built {destination}")
