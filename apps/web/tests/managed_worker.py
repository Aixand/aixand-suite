"""Real manager/bridge fixture behind the browser's intercepted transport."""

import importlib.util
import json
from pathlib import Path
import sys

from prompt_manager import Manager as Prompts
from skill_manager import Manager as Skills

root, bridge = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("managed_ui_bridge", bridge / "managed_resources.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
managers = {"prompts": Prompts(root / "prompts", packs=[]), "skills": Skills(root / "skills")}
sources, bridges, revisions = {}, {}, {}
for kind, manager in managers.items():
    source = root / (kind + "-source") / "sample"
    source.mkdir(parents=True)
    (source / "body.md").write_text("Publisher original.\n")
    if kind == "prompts":
        (source / "pack.json").write_text(json.dumps({"schema": "prompt-manager/pack-1", "name": "sample",
            "sections": {"body": {"file": "body.md"}}, "prompts": {"main": {"sections": [{"id": "body", "section": "body"}]}}}))
        status = manager.ensure_registered("fixture", source, publisher_revision=1)
        files = {"body.md": "Your saved version.\n"}
    else:
        (source / "SKILL.md").write_text("---\nname: sample\ndescription: Inspect example data.\n---\nUse body.md.\n")
        status = manager.ensure_registered("fixture", source, skill_id="default", publisher_revision=1)
        files = {"body.md": {"content": b"Your saved version.\n", "executable": False}}
    manager.save_managed("fixture", "default", files, expected_revision=status["revision"])
    bridges[kind] = module.ManagedResources(manager, skills=kind == "skills")
    sources[kind], revisions[kind] = source, 1

for line in sys.stdin:
    request = json.loads(line)
    try:
        op, args = request["op"], request.get("args", {})
        if op == "fixture-update":
            kind = args["kind"]
            revisions[kind] += 1
            (sources[kind] / "body.md").write_text(f"Publisher update {revisions[kind]}.\n")
            keyword = {"skill_id": "default"} if kind == "skills" else {"package_id": "default"}
            result = managers[kind].ensure_registered("fixture", sources[kind], publisher_revision=revisions[kind], **keyword)
        elif op == "fixture-content":
            kind = args["kind"]
            manager = managers[kind]
            result = {"text": manager.read_managed_file("fixture", "default", "body.md").decode()
                      if kind == "skills" else manager.resolve_managed("fixture")["snapshot"]["files"]["body.md"],
                      "status": manager.managed_status("fixture", "default")}
        else:
            result = bridges[op.split("-", 1)[0]].execute(op, args)
        print(json.dumps({"id": request["id"], "result": result}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request["id"], "error": str(error), "code": getattr(error, "code", "fixture")}), flush=True)
