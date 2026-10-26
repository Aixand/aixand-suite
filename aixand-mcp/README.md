# Aixand MCP compatibility package

The implementation moved to `manager-suites/orchestration-mcp` and is distributed
as `orchestration-mcp`. This package retains the `aixand_mcp` import namespace for
existing integrations. It contains no orchestration or transport implementation.

The `orchestration-mcp` distribution provides the `orchestration-mcp` command and
the `aixand-mcp` compatibility alias. Its base tools run independently of Suite;
manager, runtime, Runner, Carrier and Connect integrations are optional.

Existing `aixand_mcp.publisher` callers keep the `aixand-suite` publisher identity.
Captured zip adapters, registered revisions, customized copies and pending
reconciliation remain supported. Suite itself now imports the shared package.

See `manager-suites/orchestration-mcp/README.md` for CLI usage, the independent
host, execution contexts and optional Suite binding.
