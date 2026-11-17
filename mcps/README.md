# Aixand MCP components

This directory contains [Orchestration MCP](orchestration/README.md), the
Suite-owned MCP product for projects, manager integrations, delegated tasks,
terminals, and Runner workflows.

Use the product's [installation and first-use guide](orchestration/README.md#installation)
to connect an agent, or its [development guide](orchestration/docs/development.md)
to change the implementation. Optional tool groups have separate runtime and
permission requirements.

Orchestration MCP can run independently; Suite is an optional consumer of its
services. It is separate from Manager Suite's five published managers, including
MCP Manager, which manages MCP definitions and installation. There is no alternate
Suite MCP distribution in this directory.

[Suite overview](../README.md) · [Component boundaries](../docs/reference/components.md)
