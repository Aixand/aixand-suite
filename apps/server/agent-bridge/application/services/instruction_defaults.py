"""Suite instruction policies reference content owned by Prompt Manager."""
from copy import deepcopy
import json

from conversation_manager import ConversationError
from orchestration_mcp.resources import digest


class InstructionDefaults:
    def __init__(self, chats):
        self.chats = chats
        with chats.db:
            chats.db.execute("CREATE TABLE IF NOT EXISTS instruction_defaults (scope TEXT PRIMARY KEY, policy TEXT NOT NULL, revision INTEGER NOT NULL)")

    def scope(self, args):
        if args.get("scope") == "global":
            if args.get("provider") is not None or args.get("profile") is not None:
                raise ConversationError("validation", "Global instructions do not select a profile")
            return "global", None
        if args.get("scope") != "profile" or not args.get("provider") or not args.get("profile"):
            raise ConversationError("validation", "Select global instructions or an explicit profile")
        manager = self.chats.adapter.clients[args["provider"]].manager
        target = manager.resolve_profile(args["profile"])
        return self.profile_scope(manager, target), target

    @staticmethod
    def profile_scope(manager, target):
        config = getattr(manager, "config_path", None)
        return "profile:" + digest([str(manager.root.resolve()), str(config.resolve()) if config is not None else None, manager.provider, target.profile_id])

    def read(self, scope):
        row = self.chats.db.execute("SELECT policy,revision FROM instruction_defaults WHERE scope=?", (scope,)).fetchone()
        return dict(policy=json.loads(row[0]) if row else {"mode": "off" if scope == "global" else "inherit"}, revision=row[1] if row else 0)

    def get(self, args):
        scope, target = self.scope(args)
        return {**self.read(scope), "profileId": target.profile_id if target is not None else None}

    def validate(self, policy, scope):
        if not isinstance(policy, dict):
            raise ConversationError("validation", "Provide an instruction policy")
        mode = policy.get("mode")
        allowed = ("off", "replace") if scope == "global" else ("inherit", "off", "append", "replace")
        if mode not in allowed or set(policy) - {"mode", "target", "inputs"}:
            raise ConversationError("validation", "Invalid instruction policy")
        if mode in ("off", "inherit"):
            if set(policy) != {"mode"}:
                raise ConversationError("validation", "Only selected prompts accept targets and inputs")
        else:
            target = self.chats.resources.target("instructions", policy.get("target"))
            policy = deepcopy(policy)
            policy["target"]["store"] = target["store"]
            if not isinstance(policy.get("inputs", {}), dict):
                raise ConversationError("validation", "Prompt inputs must be an object")
        try:
            encoded = json.dumps(policy, allow_nan=False)
        except (TypeError, ValueError):
            raise ConversationError("validation", "Instruction settings must be JSON") from None
        if len(encoded.encode()) > 64 * 1024:
            raise ConversationError("validation", "Instruction settings exceed 64 KB")
        return encoded

    def set(self, args):
        scope, target = self.scope(args)
        policy = self.validate(args.get("policy"), scope)
        revision = args.get("expectedRevision")
        if type(revision) is not int or revision < 0:
            raise ConversationError("validation", "Provide the current settings revision")
        with self.chats.db:
            self.chats.db.execute("INSERT OR IGNORE INTO instruction_defaults VALUES (?,?,0)", (scope, json.dumps({"mode": "off" if scope == "global" else "inherit"})))
            changed = self.chats.db.execute("UPDATE instruction_defaults SET policy=?,revision=revision+1 WHERE scope=? AND revision=?", (policy, scope, revision))
            if not changed.rowcount:
                raise ConversationError("conflict", "Instructions changed elsewhere. Reload before saving.")
        self.chats.output({"type": "resources-changed"})
        return {**self.read(scope), "profileId": target.profile_id if target is not None else None}

    def layers(self, provider, target, request):
        instruction = request.get("instructions") or {}
        # Explicit launch selections and opt-out never read mutable defaults.
        if instruction.get("mode") in ("replace", "off") or request.get("inherit_profile") is False:
            return []
        manager = self.chats.adapter.clients[provider].manager
        # Both policies must come from the same SQLite observation.
        scopes = ("global", self.profile_scope(manager, target))
        rows = {row[0]: (json.loads(row[1]), row[2]) for row in self.chats.db.execute(
            "SELECT scope,policy,revision FROM instruction_defaults WHERE scope IN (?,?)", scopes)}
        layers = []
        for origin, scope in zip(("global", "profile"), scopes):
            policy, revision = rows.get(scope, ({"mode": "off" if origin == "global" else "inherit"}, 0))
            if policy["mode"] in ("off", "replace"):
                layers = []
            if policy["mode"] in ("append", "replace"):
                layers.append({"target": deepcopy(policy["target"]), "inputs": deepcopy(policy.get("inputs", {})),
                               "required": True, "origin": origin, "assignment_revision": revision,
                               "profile_id": target.profile_id if origin == "profile" else None})
        return layers
