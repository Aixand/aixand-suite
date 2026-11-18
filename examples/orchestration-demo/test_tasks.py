import unittest
from datetime import date
from tasks import add_task, complete_task, overdue_tasks


class TaskTests(unittest.TestCase):
    def test_empty_title_is_rejected(self):
        with self.assertRaises(ValueError):
            add_task([], " ", "2026-01-01")

    def test_due_today_is_not_overdue(self):
        tasks = []
        add_task(tasks, "Review", "2026-01-03")
        self.assertEqual(overdue_tasks(tasks, date(2026, 1, 3)), [])

    def test_completed_tasks_are_not_overdue(self):
        tasks = []
        add_task(tasks, "Completed", "2026-01-01")
        pending = add_task(tasks, "Pending", "2026-01-02")
        complete_task(tasks, 1)
        self.assertEqual(overdue_tasks(tasks, date(2026, 1, 3)), [pending])


if __name__ == "__main__":
    unittest.main()
