"""Isolated Suite gates with exact argv/cwd/environment/result evidence.

Use an interpreter containing the accepted installed manager wheels and Carrier.
No production service restart, deployment, provider credentials or model API.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("artifacts", type=Path)
parser.add_argument("--uc-bin")
parser.add_argument("--codex-bin")
parser.add_argument("--browser", action="store_true")
parser.add_argument("--only", nargs="+", help="Rerun named gates after a focused correction")
args = parser.parse_args()
suite = Path(__file__).resolve().parents[3]
server, web = suite/"apps/server", suite/"apps/web"
artifacts = args.artifacts.resolve(); artifacts.mkdir(parents=True, exist_ok=True)
environment = dict(os.environ)
environment.pop("PYTHONPATH", None)
environment["PATH"] = str(Path(sys.executable).parent)+os.pathsep+environment.get("PATH", "")
runtime_env = {}
if args.uc_bin:
    runtime_env["UC_TEST_BIN"] = str(Path(args.uc_bin).resolve())
    runtime_env["PATH"] = runtime_env["UC_TEST_BIN"]+os.pathsep+environment["PATH"]
if args.codex_bin: runtime_env["CODEX_TEST_BIN"] = str(Path(args.codex_bin).absolute())
commands = [
    ("pip-check", artifacts, [sys.executable, "-m", "pip", "check"], {}),
    ("bridge", server, [sys.executable, "-B", "-m", "unittest", "discover", "-s", "agent-bridge/tests", "-v"], runtime_env),
    ("server-build", server, ["npx", "tsc", "-p", "tsconfig.build.json", "--outDir", str(artifacts/"server-dist")], {}),
    ("server-unit", server, ["npm", "test"], {}),
    ("server-gateway", server, ["npm", "run", "test:e2e", "--", "test/agents.e2e-spec.ts", "test/agents-voice.e2e-spec.ts", "test/workflows.e2e-spec.ts"], {}),
    ("web-types", web, ["npx", "tsc", "-b", "--pretty", "false"], {}),
    ("web-build", web, ["npx", "vite", "build", "--outDir", str(artifacts/"web-dist")], {}),
    ("server-whitespace", server, ["git", "diff", "--check"], {}),
    ("web-whitespace", web, ["git", "diff", "--check"], {}),
]
if args.browser:
    commands.append(("browser", web, ["npx", "playwright", "test", "--config", "playwright.managers.config.ts", "--workers", "2"],
                     {"SUITE_TEST_ARTIFACTS": str(artifacts/"browser-results")}))
if args.only:
    unknown = set(args.only) - {row[0] for row in commands}
    if unknown: parser.error("Unknown gates: " + ", ".join(sorted(unknown)))
    commands = [row for row in commands if row[0] in args.only]
versions = {name: importlib.metadata.version(name) for name in
            ["agent-manager", "aixand-prompt-manager", "aixand-skill-manager", "aixand-mcp-manager",
             "aixand-server-manager", "orchestration-mcp", "undercurrent-sdk", "agent-client-protocol", "websockets", "carrier-mcp"]}
(artifacts/"versions.json").write_text(json.dumps({"python": sys.version, "packages": versions}, indent=2))
results = []
for name, cwd, argv, overrides in commands:
    print("Running", name, flush=True)
    started = time.monotonic()
    with (artifacts/(name+".log")).open("wb") as output:
        result = subprocess.run(argv, cwd=cwd, env=environment | overrides, stdout=output, stderr=subprocess.STDOUT)
    row = dict(name=name, cwd=str(cwd), argv=argv, environment_overrides={"PATH": environment["PATH"], "PYTHONPATH": None, **overrides},
               exit_code=result.returncode, elapsed_seconds=round(time.monotonic()-started, 3), log=str(artifacts/(name+".log")))
    results.append(row)
    (artifacts/"commands.json").write_text(json.dumps(results, indent=2))
    print(name, "exit", result.returncode, flush=True)
print(json.dumps({"passed": sum(row["exit_code"] == 0 for row in results), "total": len(results), "artifacts": str(artifacts)}), flush=True)
sys.exit(int(any(row["exit_code"] != 0 for row in results)))
