"""Check a copied Mac app's new-window link handoff with a disposable workspace."""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--timeout", type=float, default=45)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Run this check on native macOS")
    executable = args.app.resolve() / "Contents/MacOS/aixand-desktop"
    if not executable.is_file():
        parser.error("Pass the path to a copied Aixand.app")
    opened = threading.Event()
    agents = {}
    proof_path = "/browser-handoff-" + secrets.token_hex(16)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == "/api/health":
                body = json.dumps({"service": "aixand-server", "status": "ok"})
                content_type = "application/json"
            elif self.path == "/":
                if self.headers.get("User-Agent", "").startswith("Mozilla/"):
                    agents["workspace"] = self.headers["User-Agent"]
                # Same new-window link and attributes as the provider sign-in card.
                body = ('<!doctype html><title>Aixand browser handoff check</title>'
                    '<a id="sign-in" target="_blank" rel="noopener noreferrer" href="'
                    + proof_path + '">Continue to sign in</a>'
                    '<script>setTimeout(() => document.getElementById("sign-in").click(), 500)</script>')
                content_type = "text/html"
            elif self.path == proof_path:
                agents["browser"] = self.headers.get("User-Agent", "")
                body = ('<!doctype html><title>Aixand browser check passed</title>'
                    '<h1>Browser handoff check passed</h1><p>You may close this test tab.</p>')
                content_type = "text/html"
                opened.set()
            else:
                self.send_error(404)
                return
            data = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="aixand-browser-proof-") as temporary:
            home = Path(temporary)
            configuration = home / "Library/Application Support/org.aixand.suite"
            configuration.mkdir(parents=True)
            (configuration / "connections.json").write_text(json.dumps({
                "profiles": [{"id": "browser-proof", "name": "Browser handoff check",
                    "address": f"http://127.0.0.1:{server.server_port}/", "local": False}],
                "selectedId": "browser-proof", "autoConnect": True,
            }))
            env = dict(os.environ)
            for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "UNDERCURRENT_HOME",
                    "UNDERCURRENT_CONFIG", "UNDERCURRENT_ENDPOINT", "AGENT_MANAGER_HOME", "AGENT_MANAGER_CONFIG"):
                env.pop(key, None)
            env.update(HOME=str(home), USERPROFILE=str(home), CFFIXED_USER_HOME=str(home),
                AIXAND_LOCAL_HOME=str(home / "workspace"), AIXAND_SHARED_PRODUCT_PREFIX=str(home / "products"),
                AIXAND_SKIP_PATH_REGISTRATION="1", PYTHONDONTWRITEBYTECODE="1")
            with (home / "desktop.log").open("w") as log:
                child = subprocess.Popen([str(executable)], env=env, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT)
                try:
                    assert opened.wait(args.timeout), "The workspace link did not reach the system browser"
                    assert child.poll() is None, "The desktop app exited during browser handoff"
                    assert agents.get("workspace"), "The native workspace was not opened"
                    assert agents.get("browser") and agents["browser"] != agents["workspace"], \
                        "The sign-in page stayed in the embedded workspace browser"
                finally:
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait(timeout=5)
            print(json.dumps({"passed": True, "checks": ["native workspace link with target blank",
                "system browser received the link", "workspace app remains open"],
                "realSuiteDataModified": False}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    main()
