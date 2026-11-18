# Task-list example project

A dependency-free Python project for the [Suite examples](../../docs/guides/examples.md).
Requires Python 3.11 or newer. Work on a copy; keep this source as the baseline.

```sh
python demo.py
python -m unittest -v
```

Use `python3` if that is your Python command.

The baseline intentionally has one bug: completed tasks appear in the overdue
list. The demo prints two titles; only `Write release notes` should remain.
Three tests run; `test_completed_tasks_are_not_overdue` fails until the bug is fixed.

No network, credentials, database, or package installation is needed. Agent runs
still require provider access and can consume quota. Delete your copy when finished.
