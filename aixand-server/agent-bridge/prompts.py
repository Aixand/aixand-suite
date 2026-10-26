"""Prompt authoring and offline consumer inspection through registered identities."""

import os
from pathlib import Path

import agent_manager


class Prompts:
    def __init__(self, adapter):
        try:
            from prompt_manager.codec import digest
        except ImportError:
            raise agent_manager.Error(
                "Install aixand-prompt-manager in AGENTS_PYTHON to open Prompts"
            ) from None
        self.manager = adapter.clients["codex"].manager.resource_manager("prompts")
        import importlib.util
        spec = importlib.util.spec_from_file_location("suite_managed_resources", Path(__file__).with_name("managed_resources.py"))
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
                owner="aixand-suite", writable=configured is not None,
                expected_revision=None,
            )
        manager = adapter.clients["codex"].manager
        self.local_consumer_id = "agent-manager-" + digest(str(manager.root.resolve()))[7:23]
        self.manager.register_consumer(
            self.local_consumer_id,
            adapter="agent-manager",
            root=manager.root.resolve().parent,
            config=manager.config_path,
            label="Agent Manager · Codex",
        )

    def consumer(self, identifier):
        row = next(
            (
                row
                for row in self.manager.catalog()["consumers"]
                if row["id"] == identifier
            ),
            None,
        )
        if row is None or row.get("error"):
            raise agent_manager.Error("Consumer is unavailable; refresh the catalog")
        if not Path(row["root"]).is_dir():
            raise agent_manager.Error("Consumer installation is unavailable")
        return agent_manager.Manager(
            row["provider"], root=row["root"], config=row["config"]
        )

    def execute(self, op, args):
        pm = self.manager
        if op.startswith("prompts-managed-"):
            return self.owned.execute(op, args)
        if op == "prompts-catalog":
            result = pm.catalog()
            result["sourceRegistrations"] = pm.sources()
            views = []
            for consumer in result["consumers"]:
                consumer = {**consumer, "local": consumer["id"] == self.local_consumer_id}
                try:
                    metadata = self.consumer(consumer["id"]).instruction_catalog(
                        limit=50
                    )
                    views.append({**consumer, "status": "available", **metadata})
                except (agent_manager.Error, OSError) as error:
                    views.append(
                        {
                            **consumer,
                            "status": "unavailable",
                            "error": str(error),
                            "profiles": [],
                            "launches": [],
                        }
                    )
            result["consumers"] = views
            return result
        if op == "prompts-source-register":
            return pm.register_source(args["sourceId"], args["paths"], label=args.get("label"),
                owner="aixand-suite", writable=args.get("writable", False), expected_revision=args["expectedRevision"])
        if op == "prompts-source-unregister":
            return pm.unregister_source(args["sourceId"], expected_revision=args["expectedRevision"])
        if op == "prompts-application-register":
            return pm.register_application(args["applicationId"], prompts=args["prompts"],
                label=args.get("label"), fallback_policy=args.get("fallbackPolicy", "none"),
                expected_revision=args["expectedRevision"])
        if op == "prompts-application-set":
            return pm.set_application_prompt(args["applicationId"], args["logicalPrompt"],
                                             args["target"], expected_revision=args["expectedRevision"])
        if op == "prompts-application-unregister":
            return pm.unregister_application(args["applicationId"], expected_revision=args["expectedRevision"])
        if op == "prompts-application-resolve":
            return pm.resolve_application(args["applicationId"], args["logicalPrompt"])
        if op == "prompts-application-render":
            return pm.render_application(args["applicationId"], args["logicalPrompt"],
                                         args.get("inputs", {}), format="messages")
        if op == "prompts-history":
            return self.consumer(args["consumerId"]).instruction_catalog(
                limit=50, offset=args.get("offset", 0)
            )
        if op == "prompts-snapshot":
            return self.consumer(args["consumerId"]).instruction_launch(
                args["launchId"]
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
        if op in {"prompts-bind", "prompts-unbind"}:
            manager = self.consumer(args["consumerId"])
            if op == "prompts-unbind":
                manager.clear_profile_instructions(
                    args["profile"],
                    expected_binding_digest=args["expectedBindingDigest"],
                )
                return None
            row, _ = pm.catalog_source(args["packId"])
            if row["kind"] != "release" or row["status"] != "available":
                raise agent_manager.Error("Bindings require a valid immutable release")
            reference = row["reference"] + "/" + args["prompt"]
            return manager.set_profile_instructions(
                args["profile"],
                reference,
                inputs=args.get("inputs", {}),
                expected_binding_digest=args["expectedBindingDigest"],
            )
        raise agent_manager.Error("Unsupported prompt operation")
