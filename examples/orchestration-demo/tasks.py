"""Small in-memory task list for the Suite orchestration examples."""
from datetime import date


def add_task(tasks, title, due):
    if not title.strip():
        raise ValueError("A title is required")
    task = {"id": max((item["id"] for item in tasks), default=0) + 1,
            "title": title.strip(), "due": date.fromisoformat(due), "done": False}
    tasks.append(task)
    return task


def complete_task(tasks, task_id):
    task = next(item for item in tasks if item["id"] == task_id)
    task["done"] = True


def overdue_tasks(tasks, today):
    return [item for item in tasks if item["due"] < today]
