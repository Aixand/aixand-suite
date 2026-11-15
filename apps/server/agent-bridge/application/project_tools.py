"""Shared project operations and durable project launch targets."""

import json
import os
from pathlib import Path
import uuid

from orchestration_mcp.errors import OrchestrationError
from .services.projects import project_name
from orchestration_mcp.optional import agents


class ProjectTools:
    def __init__(self, projects):
        self.projects, self.db = projects, projects.db
        with self.db:
            self.db.execute(
                "CREATE TABLE IF NOT EXISTS project_tool_operations (id TEXT PRIMARY KEY, intent TEXT NOT NULL, record TEXT NOT NULL)"
            )

    def save(self, key, intent, record):
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO project_tool_operations VALUES (?,?,?)",
                (key, intent, json.dumps(record)),
            )

    def operation(self, key, intent):
        row = self.db.execute(
            "SELECT intent,record FROM project_tool_operations WHERE id=?", (key,)
        ).fetchone()
        if row and row["intent"] != intent:
            raise OrchestrationError(
                "conflict", "Operation identity was reused with different arguments"
            )
        return json.loads(row["record"]) if row else None

    def view(self, row):
        project = dict(row)
        path = Path(project["path"])
        project["available"] = path.is_dir() and os.access(path, os.R_OK | os.X_OK)
        return project

    def get(self, identifier):
        row = self.projects.find(identifier)
        if row is None:
            raise OrchestrationError("not_found", "Project not found")
        return self.view(row)

    def target(self, args):
        # Retain the original selector, not a mutable registry lookup, across retries.
        if ("project_id" in args) == ("cwd" in args):
            raise OrchestrationError(
                "validation", "Provide exactly one of project_id or cwd"
            )
        if "project_id" not in args:
            return dict(args)
        key = args["operation_id"]
        intent = json.dumps(["conversation-target", args], sort_keys=True)
        record = self.operation(key, intent)
        if record is None:
            project = self.get(args["project_id"])
            if not project["available"]:
                raise OrchestrationError(
                    "validation", "Project directory is not accessible"
                )
            record = {"project": project}
            self.save(key, intent, record)
        return {
            **args,
            "project_id": record["project"]["id"],
            "cwd": record["project"]["path"],
        }

    def inspect(self, key):
        row = self.db.execute(
            "SELECT record FROM project_tool_operations WHERE id=?", (key,)
        ).fetchone()
        record = json.loads(row[0]) if row else None
        if record is None or "tool" not in record:
            return None
        return {
            "schema": "orchestration-mcp/execution-operation-1",
            "operation_id": key,
            "tool": record["tool"],
            "status": "completed" if record.get("result") else "uncertain",
            "phase": record["phase"],
            "path": record["path"],
            "result": record.get("result"),
        }

    def captured(self, key):
        row = self.db.execute(
            "SELECT record FROM project_tool_operations WHERE id=?", (key,)
        ).fetchone()
        return json.loads(row[0]).get("project") if row else None

    async def execute(self, name, args, current_project_id=None):
        if name == "get_project":
            return {"project": self.get(args["project_id"])}
        if name == "list_projects":
            query = args.get("query", "").strip().casefold()
            rows = [
                row
                for row in self.projects.list_projects()
                if query in row["name"].casefold() or query in row["path"].casefold()
            ]
            offset, limit = args.get("offset", 0), args.get("limit", 20)
            return {
                "projects": [self.view(row) for row in rows[offset : offset + limit]],
                "total": len(rows),
                "next_offset": offset + limit if offset + limit < len(rows) else None,
                "current_project_id": current_project_id,
                "currentProjectId": current_project_id,
            }
        async with self.projects.lock("projects:registry"):
            key = args["operation_id"]
            intent = json.dumps([name, args], sort_keys=True)
            record = self.operation(key, intent)
            if record and record.get("result"):
                return record["result"]
            if record is None:
                if "\x00" in args["path"] or not args["path"].strip():
                    raise OrchestrationError(
                        "validation", "Provide an absolute directory path"
                    )
                raw = Path(args["path"].strip()).expanduser()
                if not raw.is_absolute():
                    raise OrchestrationError(
                        "validation", "Provide an absolute directory path"
                    )
                path = raw.resolve()
                try:
                    name_value = project_name(args.get("name", path.name))
                except agents.Error as error:
                    raise OrchestrationError("validation", str(error)) from error
                if name == "create_project":
                    if raw.exists() or raw.is_symlink():
                        raise OrchestrationError(
                            "conflict",
                            "Destination already exists; use register_project",
                        )
                    if not path.parent.is_dir():
                        raise OrchestrationError(
                            "validation", "Parent directory must already exist"
                        )
                    if self.db.execute(
                        "SELECT 1 FROM projects WHERE name=? COLLATE NOCASE OR path=?",
                        (name_value, str(path)),
                    ).fetchone():
                        raise OrchestrationError(
                            "conflict", "Project name or path is already registered"
                        )
                    from .services.projects import PROJECT_LIMIT

                    if len(self.projects.list_projects()) >= PROJECT_LIMIT:
                        raise OrchestrationError("validation", "Project limit reached")
                record = {
                    "tool": name,
                    "path": str(path),
                    "name": name_value,
                    "project_id": str(uuid.uuid4()),
                    "phase": "prepared",
                }
                self.save(key, intent, record)
            path = Path(record["path"])
            if name == "create_project" and record["phase"] != "directory_created":
                if path.exists() or path.is_symlink():
                    raise OrchestrationError(
                        "uncertain",
                        "Directory creation is unconfirmed; inspect the retained path before registering it",
                        uncertain=True,
                    )
                record["phase"] = "creating_directory"
                self.save(key, intent, record)
                path.mkdir()
                record["phase"] = "directory_created"
                self.save(key, intent, record)
            try:
                project = self.projects.create(
                    {"path": record["path"], "name": record["name"]},
                    project_id=record["project_id"],
                )
            except agents.Error as error:
                raise OrchestrationError("validation", str(error)) from error
            record["result"] = {"project": self.view(project), "operation_id": key}
            self.save(key, intent, record)
            return record["result"]
