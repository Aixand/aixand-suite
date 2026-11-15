"""Suite transports intent; Agent Manager owns resource selection and delivery."""
import asyncio


def options(args):
    if "resources" in args:
        from agent_manager.resources.preparation import exclusive
        exclusive(args["resources"], skills=args.get("skills"), mcp=args.get("mcp"),
            instructions=args.get("instructions"), use_profile_instructions=args.get("useProfileInstructions", False))
        return {"resources": args["resources"]}
    if any(key in args for key in ("skills", "mcp", "useProfileInstructions")):
        return {"use_profile_instructions": args.get("useProfileInstructions", False),
                "skills": args.get("skills"), "mcp": args.get("mcp")}
    return {"resources": {}}


async def execute(adapter, op, args):
    client = adapter.clients[args["provider"]]
    if op == "resource-catalog":
        return await client.resource_catalog()
    if op == "profile-resources-get":
        return await client.profile_resources(args["profile"])
    if op == "profile-resources-set":
        result = await client.set_profile_resources(args["profile"], args["resources"], expected_revision=args["expectedRevision"])
        return result
    if op == "launch-preview":
        application = adapter.chat_store().application.preview(args['provider'], args['applicationPreset']) if args.get('applicationPreset') else None
        return await client.preview_launch(args["profile"], resources=args.get("resources", {}),
            cwd=args.get("cwd"), backend=args.get("backend", "native-codex"), mode=args.get("mode", "backend"),
            **({'application_resources': application} if application is not None else {}))
    raise ValueError("Unknown resource operation")
