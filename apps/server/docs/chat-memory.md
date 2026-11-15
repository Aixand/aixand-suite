# Plan chat memory capacity

Use isolated workloads to size a local beta deployment. There is no qualified
minimum RAM guarantee for a complete Suite installation. Provider processes,
loaded histories, tools, browser tabs and speech models have separate costs.

## Measure the workload

On Linux, inspect `/proc/<pid>/smaps_rollup` for each relevant process. RSS counts
resident pages and can double-count shared pages. PSS apportions shared pages;
swapped pages need a separate allowance. MiB means 1,048,576 bytes.

Measure idle startup, loaded history, active turns and cleanup separately. Include
Suite Server, private Python workers, Undercurrent, provider processes, MCP servers,
tool subprocesses and browser tabs. Measure Vox separately when enabled. A saved
conversation count alone cannot predict resident provider threads or peak memory.

Use temporary homes without real credentials for fixture measurements. Live model
checks require deliberate authorization and can consume quota. Stop only the
processes created for the measurement, and remove their temporary homes afterward.

A transcript transport bound is not a RAM budget. Recheck capacity after changing
provider versions, models, resource attachments or concurrent workload.
