"""Translate Suite requests to the owning manager's public source lifecycle API."""


def execute(manager, operation, args):
    if operation == "source-capabilities":
        return manager.source_capabilities()
    if operation == "source-job-start":
        return manager.start_source_job(
            args["operation"], args["request"], key=args["key"]
        )
    if operation == "source-job":
        return manager.source_job(args["jobId"])
    if operation == "source-jobs":
        return manager.source_jobs()
    if operation == "source-cancel":
        return manager.cancel_source_job(args["jobId"])
    if operation == "source-check-due":
        return manager.check_due_sources()
    if operation == "source-status":
        return manager.source_status(args["publisherId"], args["resourceId"])
    if operation == "source-settings":
        options = {key: args[key] for key in ("pinned", "label") if key in args}
        if "intervalHours" in args:
            options["interval_hours"] = args["intervalHours"]
        return manager.source_settings(
            args["publisherId"],
            args["resourceId"],
            expected_revision=args["expectedRevision"],
            **options,
        )
    raise ValueError("Unsupported resource source operation")
