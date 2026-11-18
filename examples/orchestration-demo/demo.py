"""Print a deterministic example; no files or external services are changed."""
from datetime import date
from tasks import add_task, complete_task, overdue_tasks

items = []
add_task(items, "Review pull request", "2026-01-01")
add_task(items, "Write release notes", "2026-01-02")
complete_task(items, 1)
for item in overdue_tasks(items, date(2026, 1, 3)):
    print(item["title"])
