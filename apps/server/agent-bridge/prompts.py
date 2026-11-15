"""Prompt authoring and offline consumer inspection through registered identities."""

import os
from pathlib import Path

import agent_manager


class Prompts:
    def __init__(self, adapter):
        try:
            from prompt_manager import Manager
            from prompt_manager.codec import digest
        except ImportError:
            raise agent_manager.Error(
                "Install aixand-prompt-manager in AGENTS_PYTHON to open Prompts"
            ) from None
        self.manager = Manager()
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "suite_managed_resources", Path(__file__).with_name("managed_resources.py")
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.owned = module.ManagedResources(self.manager)
        configured = os.environ.get(
            "PROMPTS_PACK_PATHS", os.environ.get("PROMPT_MANAGER_PACKS")
        )
        if configured is None:
            paths = []
        else:
            paths = [
                Path(path).expanduser().resolve()
                for path in configured.split(os.pathsep)
                if path
            ]
        existing = {row["id"] for row in self.manager.sources()}
        for path in paths:
            identifier = "suite-" + digest(str(path))[7:23]
            if identifier in existing:
                continue
            self.manager.register_source(
                identifier,
                [path],
                label=path.parent.name if path.name == "packs" else path.name,
                owner="aixand-suite",
                writable=configured is not None,
                expected_revision=None,
            )

    def execute(self, op, args):
        pm = self.manager
        if op.startswith("prompts-managed-"):
            return self.owned.execute(op, args)
        if op == "prompts-catalog":
            result = pm.catalog()
            result["sourceRegistrations"] = pm.sources()
            # Old consumer registrations remain in the manager store, but Agent
            # Manager no longer exposes profile binding/history interfaces.
            result["consumers"] = []
            result["profileBindingsSupported"] = False
            return result
        if op == "prompts-source-register":
            return pm.register_source(
                args["sourceId"],
                args["paths"],
                label=args.get("label"),
                owner="aixand-suite",
                writable=args.get("writable", False),
                expected_revision=args["expectedRevision"],
            )
        if op == "prompts-source-unregister":
            return pm.unregister_source(
                args["sourceId"], expected_revision=args["expectedRevision"]
            )
        if op == "prompts-application-register":
            return pm.register_application(
                args["applicationId"],
                prompts=args["prompts"],
                label=args.get("label"),
                fallback_policy=args.get("fallbackPolicy", "none"),
                expected_revision=args["expectedRevision"],
            )
        if op == "prompts-application-set":
            return pm.set_application_prompt(
                args["applicationId"],
                args["logicalPrompt"],
                args["target"],
                expected_revision=args["expectedRevision"],
            )
        if op == "prompts-application-unregister":
            return pm.unregister_application(
                args["applicationId"], expected_revision=args["expectedRevision"]
            )
        if op == "prompts-application-resolve":
            return pm.resolve_application(args["applicationId"], args["logicalPrompt"])
        if op == "prompts-application-render":
            return pm.render_application(
                args["applicationId"],
                args["logicalPrompt"],
                args.get("inputs", {}),
                format="messages",
            )
        if op in {
            "prompts-history",
            "prompts-snapshot",
            "prompts-bind",
            "prompts-unbind",
        }:
            raise agent_manager.Error(
                "Profiles do not own prompt bindings; select instructions when starting a chat"
            )
        if op == "prompts-show":
            return pm.show_catalog(args["packId"], prompt=args.get("prompt"))
        if op in {"prompts-preview", "prompts-validate"}:
            _, source = pm.catalog_source(args["packId"])
            return (
                pm.validate(source)
                if op == "prompts-validate"
                else pm.render(
                    source,
                    args.get("inputs", {}),
                    prompt=args["prompt"],
                    format="messages",
                )
            )
        if op == "prompts-diff":
            _, before = pm.catalog_source(args["beforeId"])
            _, after = pm.catalog_source(args["packId"])
            return pm.diff(
                before,
                after,
                prompt=args.get("prompt"),
                inputs=args.get("inputs"),
                format="messages",
            )
        if op == "prompts-save":
            return pm.save_catalog_file(
                args["packId"],
                args["file"],
                args["text"],
                expected_digest=args["expectedDigest"],
            )
        if op == "prompts-release":
            return pm.release_catalog(
                args["packId"], args["version"], expected_digest=args["expectedDigest"]
            )
        raise agent_manager.Error("Unsupported prompt operation")
