"""Server-backed Codex process policy, captured when an execution starts."""
import os
from .errors import OrchestrationError


class CodexServerSettings:
    def __init__(self, executions, output=None):
        self.executions, self.output = executions, output

    @property
    def db(self):
        db = self.executions.db
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS codex_server_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, revision INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO codex_server_settings VALUES (1, 'separate', 0)")
        return db

    def get(self):
        mode, revision = self.db.execute("SELECT mode,revision FROM codex_server_settings WHERE id=1").fetchone()
        return dict(mode=mode, revision=revision, sharedSupported=os.name != "nt")

    def set(self, args):
        if (set(args) != {'mode', 'expectedRevision'} or args.get('mode') not in ('separate', 'shared')
                or type(args.get('expectedRevision')) is not int or args['expectedRevision'] < 0):
            raise OrchestrationError('validation', 'Choose separate or shared and provide the current settings revision')
        if args["mode"] == "shared" and os.name == "nt":
            raise OrchestrationError("unsupported", "Shared Codex servers are not yet supported on Windows")
        db = self.db
        with db:
            changed = db.execute("UPDATE codex_server_settings SET mode=?,revision=revision+1 WHERE id=1 AND revision=?",
                                 (args['mode'], args['expectedRevision']))
            if not changed.rowcount:
                raise OrchestrationError('conflict', 'Codex server settings changed elsewhere. Reload and try again.')
        result = self.get()
        if self.output:
            self.output(dict(type='codex-server-settings-changed', settings=result))
        return result
