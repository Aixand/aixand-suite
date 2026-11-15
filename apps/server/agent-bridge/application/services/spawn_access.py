"""Saved spawn defaults and explicit, durable permission presets."""
import agent_manager


MODES = {
    "read-only": ("read-only", "on-request"),
    "workspace-write": ("workspace-write", "on-request"),
    "workspace-auto": ("workspace-write", "never"),
    "full-access": ("danger-full-access", "never"),
}
SCHEMA = {"type": "string", "enum": list(MODES),
          "description": "Access explicitly requested by the user. Otherwise omit to inherit the saved default, including for audits and reviews. When the default is manual, an explicit concrete mode is required. read-only inspects; workspace-write edits with approvals; workspace-auto edits within the sandbox without prompts; full-access is YOLO."}


def validate(mode):
    if not isinstance(mode, str) or mode not in MODES:
        raise agent_manager.Error("Choose read-only, workspace-write, workspace-auto, or full-access")
    return mode


def fields(mode):
    sandbox, approval = MODES[validate(mode)]
    return {"permissionMode": mode, "accessMode": sandbox, "approvalPolicy": approval}


def runtime(record):
    # An unspecified preset uses on-request approvals.
    return {"sandbox": record.get("accessMode") or "workspace-write",
            "approvalPolicy": record.get("approvalPolicy") or "on-request"}


def instructions(record):
    if runtime(record)["sandbox"] == "read-only":
        return "This task has read-only access. Inspect and report; do not edit files."
    if runtime(record)["sandbox"] == "danger-full-access":
        return "This task has full access without sandboxing or approval prompts. Make the changes requested by the user."
    return "This task can edit files in its workspace. Make the changes requested by the user." + (
        " Approval prompts are disabled; report blocked operations." if runtime(record)["approvalPolicy"] == "never" else "")


class SpawnAccess:
    def __init__(self, chats):
        self.chats = chats
        with chats.db:
            chats.db.execute("CREATE TABLE IF NOT EXISTS spawn_settings (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, revision INTEGER NOT NULL)")
            chats.db.execute("INSERT OR IGNORE INTO spawn_settings VALUES (1, 'read-only', 0)")

    def get(self):
        row = self.chats.db.execute("SELECT mode,revision FROM spawn_settings WHERE id=1").fetchone()
        return {"defaultMode": row["mode"], "revision": row["revision"]}

    def resolve(self, mode=None):
        if mode is None and self.get()["defaultMode"] == "manual":
            raise agent_manager.Error("Default access is Manual. Specify permissionMode for this launch or for every workflow stage.")
        return validate(self.get()["defaultMode"] if mode is None else mode)

    def capture(self, steps, mode=None):
        """Resolve an entire launch before any worker is created; freeze defaults."""
        saved = self.get()
        default = validate(mode) if mode is not None else saved["defaultMode"]
        missing = [step["id"] for step in steps if step.get("permissionMode") is None and default == "manual"]
        if missing:
            raise agent_manager.Error("Default access is Manual. Specify permissionMode for stages: " + ", ".join(missing))
        return {"default": None if default == "manual" else default,
                "source": "workflow" if mode is not None else "default",
                "manual": default == "manual", "revision": saved["revision"],
                "steps": {step["id"]: validate(step.get("permissionMode", default)) for step in steps}}

    def set(self, args):
        mode = args.get("defaultMode")
        if mode != "manual":
            mode = validate(mode)
        revision = args.get("expectedRevision")
        if type(revision) is not int or revision < 0 or set(args) != {"defaultMode", "expectedRevision"}:
            raise agent_manager.Error("Provide the current spawn settings revision")
        with self.chats.db:
            changed = self.chats.db.execute("UPDATE spawn_settings SET mode=?,revision=revision+1 WHERE id=1 AND revision=?", (mode, revision))
            if not changed.rowcount:
                raise agent_manager.Error("Spawn settings changed elsewhere. Reload the settings and try again.")
        result = self.get()
        self.chats.output({"type": "spawn-settings-changed", "settings": result})
        return result
