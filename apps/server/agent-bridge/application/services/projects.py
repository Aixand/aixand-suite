"""Suite-owned project registry, discovery jobs and atomic import journal."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import uuid

import agent_manager

from application.services import project_discovery as discovery, project_files as files

TOOL_ARGUMENTS = {
    "add_project": {"name", "path"},
    "remove_project": {"projectId"},
    "discover_projects": {"root", "add", "includeNested", "exclude"},
    "get_project_discovery": {"jobId", "offset"},
    "filter_project_discovery": {"jobId", "scope", "query", "candidateIds"},
    "add_discovered_projects": {"jobId", "selection"},
    "cancel_project_discovery": {"jobId"},
}
TERMINAL = {"completed", "partial", "cancelled", "interrupted", "failed"}
PROJECT_LIMIT = 200


def identifier(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise agent_manager.Error("A valid UUID is required") from None


def project_name(value):
    if not isinstance(value, str):
        raise agent_manager.Error("Enter a project name of up to 128 characters")
    value = value.strip()
    if not value or len(value) > 128 or any(ord(char) < 32 for char in value):
        raise agent_manager.Error("Enter a project name of up to 128 characters")
    return value


class Projects:
    def __init__(self, chats):
        self.chats, self.db = chats, chats.db
        self.tasks, self.cancellations = {}, {}
        self.closing = False
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="suite-discovery")
        self.scan = discovery.scan
        with self.db:
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS projects_unique_path ON projects(path)")
            self.db.execute("CREATE TABLE IF NOT EXISTS project_discoveries (id TEXT PRIMARY KEY, origin_kind TEXT NOT NULL, origin_id TEXT NOT NULL, record TEXT NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS project_candidates (job_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(job_id,id))")
            for row in self.db.execute("SELECT record FROM project_discoveries").fetchall():
                job = json.loads(row[0])
                if job["state"] not in TERMINAL:
                    job.update(state="interrupted", scanComplete=False,
                               error="The backend restarted before this discovery finished. Start a new scan to continue.")
                    self.write(job)

    def find(self, project_id):
        return self.db.execute(
            "SELECT id,name,path FROM projects WHERE id=?", (project_id,)
        ).fetchone()

    def lock(self, name):
        return self.chats.locks.setdefault(name, asyncio.Lock())

    def list_projects(self):
        return [dict(row) for row in self.db.execute("SELECT id,name,path FROM projects ORDER BY name COLLATE NOCASE")]

    def create(self, args, *, project_id=None):
        name = project_name(args.get("name"))
        path = args.get("path")
        if not isinstance(path, str) or not 1 <= len(path.strip()) <= 4096 or "\x00" in path:
            raise agent_manager.Error("Enter an absolute local directory path of up to 4096 characters")
        raw_path = Path(path.strip()).expanduser()
        if not raw_path.is_absolute():
            raise agent_manager.Error("Enter an absolute local directory path")
        try:
            directory = raw_path.resolve()
        except (OSError, ValueError, RuntimeError):
            raise agent_manager.Error("Project directory could not be resolved") from None
        if not directory.is_dir():
            raise agent_manager.Error("Project directory does not exist")
        if not os.access(directory, os.R_OK | os.X_OK):
            raise agent_manager.Error("Project directory is not accessible")
        existing = self.db.execute("SELECT * FROM projects WHERE name=? COLLATE NOCASE", (name,)).fetchone()
        if existing:
            if existing["path"] == str(directory):
                return dict(existing)
            raise agent_manager.Error("A project with this name already exists")
        existing = self.db.execute("SELECT * FROM projects WHERE path=?", (str(directory),)).fetchone()
        if existing:
            raise agent_manager.Error(f'This directory is already registered as "{existing["name"]}". Use the existing project.')
        if self.db.execute("SELECT count(*) FROM projects").fetchone()[0] >= PROJECT_LIMIT:
            raise agent_manager.Error("Project limit reached")
        project = {"id": project_id or str(uuid.uuid4()), "name": name, "path": str(directory)}
        with self.db:
            self.db.execute("INSERT INTO projects VALUES (:id,:name,:path)", project)
        self.chats.output({"type": "projects-changed"})
        return project

    def get(self, job_id, origin=None):
        row = self.db.execute("SELECT record FROM project_discoveries WHERE id=?", (identifier(job_id),)).fetchone()
        if not row:
            raise agent_manager.Error("Project discovery was not found")
        job = json.loads(row[0])
        if origin and job["origin"] != origin:
            raise agent_manager.Error("This discovery belongs to another conversation")
        return job

    async def remove(self, args, origin=None):
        key = identifier(args.get("key"))
        project_id = identifier(args.get("projectId"))
        signature = json.dumps(["project-remove", {"key": key, "projectId": project_id}, origin], sort_keys=True)
        async with self.lock("operation:" + key):
            old = self.previous(key, signature)
            if old:
                return old
            async with self.lock("projects:registry"):
                row = self.db.execute("SELECT id,name,path FROM projects WHERE id=?", (project_id,)).fetchone()
                project = dict(row) if row else None
                jobs = []
                result = {"projectId": project_id, "removed": project is not None, "project": project}
                # Registration and its retry result commit together. Candidate
                # snapshots remain saved; only their live registry status changes.
                with self.db:
                    if project:
                        jobs = [json.loads(row[0]) for row in self.db.execute(
                            "SELECT DISTINCT d.record FROM project_discoveries d JOIN project_candidates c "
                            "ON c.job_id=d.id WHERE json_extract(c.record,'$.path')=?", (project["path"],))]
                        self.db.execute("DELETE FROM projects WHERE id=?", (project_id,))
                        for job in jobs:
                            self.write(job)
                    self.journal(key, signature, result)
                if project:
                    self.chats.output({"type": "projects-changed"})
                    for job in jobs:
                        self.publish(job)
                return result

    def view(self, job):
        rows = self.candidate_views(job)
        visible = self.filtered_candidates(job, rows)
        return {**job, "resultFilter": job.get("resultFilter", {"scope": "all", "query": ""}),
                "filtered": {"matched": len(visible), "total": len(rows), "preview": [
                    {key: row[key] for key in ("id", "path", "suggestedName", "classification")} for row in visible[:5]]},
                "defaultExclusions": sorted(discovery.IGNORED),
                "url": "#/chat/" + job["origin"]["id"] if job["origin"]["kind"] == "chat" else None}

    def write(self, job):
        job.update(revision=job.get("revision", 0) + 1, updatedAt=int(time.time() * 1000))
        self.db.execute("INSERT OR REPLACE INTO project_discoveries VALUES (?,?,?,?)",
                        (job["id"], job["origin"]["kind"], job["origin"]["id"], json.dumps(job)))

    def publish(self, job):
        self.chats.output({"type": "project-discovery-updated", "discovery": self.view(job)})

    def previous(self, key, signature):
        row = self.db.execute("SELECT * FROM operations WHERE key=?", (key,)).fetchone()
        if row:
            if row["signature"] != signature:
                raise agent_manager.Error("Operation key was reused with different arguments")
            if row["status"] != "done":
                raise agent_manager.Error("This operation has an unconfirmed outcome")
            return json.loads(row["result"])
        return None

    def journal(self, key, signature, result):
        self.db.execute("INSERT INTO operations VALUES (?,?, 'done',?)", (key, signature, json.dumps(result)))

    def listing(self, args, origin=None):
        offset, limit = args.get("offset", 0), args.get("limit", 20)
        self.page_bounds(offset, limit)
        where, values = ("WHERE origin_kind=? AND origin_id=?", [origin["kind"], origin["id"]]) if origin else ("", [])
        rows = self.db.execute(f"SELECT record FROM project_discoveries {where} ORDER BY rowid DESC LIMIT ? OFFSET ?",
                               [*values, limit + 1, offset]).fetchall()
        jobs, size = [], 0
        for row in rows[:limit]:
            value = self.view(json.loads(row[0]))
            length = len(json.dumps(value).encode())
            if jobs and size + length > 500_000:
                break
            jobs.append(value)
            size += length
        return {"jobs": jobs, "nextOffset": offset + len(jobs) if len(rows) > len(jobs) else None}

    @staticmethod
    def page_bounds(offset, limit):
        if type(offset) is not int or not 0 <= offset <= 100_000 or type(limit) is not int or not 1 <= limit <= 100:
            raise agent_manager.Error("Invalid discovery pagination")

    def candidates(self, job_id):
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT record FROM project_candidates WHERE job_id=? ORDER BY rowid", (job_id,))]

    def candidate_views(self, job):
        rows = self.candidates(job["id"])
        projects = self.list_projects()
        by_path = {}
        for project in projects:
            by_path.setdefault(project["path"], []).append(project)
        # Match the registry's SQLite NOCASE naming semantics.
        fold = lambda value: value.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
        used = {fold(project["name"]) for project in projects}
        frequencies = {}
        for row in rows:
            if row["path"] not in by_path:
                base = fold(row["suggestedName"])
                frequencies[base] = frequencies.get(base, 0) + 1
        for row in sorted(rows, key=lambda value: value["path"]):
            existing = by_path.get(row["path"], [])
            row["existingProjectIds"] = [project["id"] for project in existing]
            row["unavailable"] = row["id"] in (job.get("registration") or {}).get("unavailableCandidateIds", [])
            if existing:
                row["suggestedName"] = existing[0]["name"]
                continue
            base = row["suggestedName"]
            name = base
            if fold(name) in used or frequencies[fold(base)] > 1:
                parents = list(Path(row["path"]).parents)
                for count in range(1, min(len(parents), 5) + 1):
                    qualifier = "/".join(reversed([parent.name for parent in parents[:count] if parent.name]))
                    suffix = " (" + qualifier + ")"
                    name = base[:max(1, 128 - len(suffix))] + suffix
                    if len(name) <= 128 and fold(name) not in used:
                        break
                if len(name) > 128 or fold(name) in used:
                    name = base[:110] + " (" + hashlib.sha256(row["path"].encode()).hexdigest()[:12] + ")"
                index = 1
                while fold(name) in used:
                    suffix = " (" + hashlib.sha256(row["path"].encode()).hexdigest()[:12] + f"-{index})"
                    name = base[:128 - len(suffix)] + suffix
                    index += 1
            used.add(fold(name))
            row["suggestedName"] = name
        return rows

    @staticmethod
    def normalize_filter(args):
        scope, query = args.get("scope", "all"), args.get("query", "")
        if scope not in ("all", "roots") or not isinstance(query, str) or len(query) > 512 or "\x00" in query:
            raise agent_manager.Error("Use an all or roots filter and a name/path query of up to 512 characters")
        value = {"scope": scope, "query": query.strip()}
        if "candidateIds" in args:
            ids = args["candidateIds"]
            if not isinstance(ids, list) or len(ids) > 2000:
                raise agent_manager.Error("Supply up to 2000 discovered candidate UUIDs")
            value["candidateIds"] = sorted({identifier(candidate_id) for candidate_id in ids})
        return value

    @staticmethod
    def filtered_candidates(job, rows):
        value = job.get("resultFilter", {})
        query = value.get("query", "").casefold()
        ids = set(value["candidateIds"]) if "candidateIds" in value else None
        return [row for row in rows if
                (value.get("scope", "all") != "roots" or row["classification"] == "root") and
                (not query or query in row["suggestedName"].casefold() or query in row["path"].casefold()) and
                (ids is None or row["id"] in ids)]

    async def filter_results(self, args, origin=None):
        key = identifier(args["key"])
        job = self.get(args["jobId"], origin)
        value = self.normalize_filter(args)
        signature = json.dumps(["project-discovery-filter", args, origin], sort_keys=True)
        async with self.lock("operation:" + key):
            if self.previous(key, signature):
                return self.view(self.get(job["id"], origin))
            ids = {row["id"] for row in self.candidates(job["id"])}
            if not set(value.get("candidateIds", [])) <= ids:
                raise agent_manager.Error("Filter contains a candidate from another discovery")
            job = self.get(job["id"], origin)
            job["resultFilter"] = value
            with self.db:
                self.write(job)
                self.journal(key, signature, {"jobId": job["id"]})
            self.publish(job)
            return self.view(job)

    def results(self, args, origin=None):
        job = self.get(args["jobId"], origin)
        offset, limit = args.get("offset", 0), args.get("limit", 100)
        self.page_bounds(offset, limit)
        rows = self.filtered_candidates(job, self.candidate_views(job))
        return {"candidates": rows[offset:offset + limit], "total": len(rows),
                "nextOffset": offset + limit if offset + limit < len(rows) else None}

    async def start(self, args, origin, *, source_turn_id=None, source_call_id=None):
        key = identifier(args["key"])
        root = args.get("root")
        if not isinstance(root, str) or not 1 <= len(root.strip()) <= 4096 or "\x00" in root:
            raise agent_manager.Error("Enter an absolute discovery directory path")
        raw_path = Path(root.strip()).expanduser()
        if not raw_path.is_absolute():
            raise agent_manager.Error("Enter an absolute discovery directory path")
        mode = args.get("mode", "preview")
        nested, exclude = args.get("includeNested", False), args.get("exclude", [])
        if mode not in ("preview", "add") or type(nested) is not bool:
            raise agent_manager.Error("Invalid project discovery options")
        if not isinstance(exclude, list) or len(exclude) > 32 or any(
            not isinstance(pattern, str) or not 1 <= len(pattern) <= 512 or "\x00" in pattern for pattern in exclude):
            raise agent_manager.Error("Supply up to 32 directory exclusion patterns")
        signature = json.dumps(["project-discovery-start", args, origin], sort_keys=True)
        async with self.lock("operation:" + key):
            old = self.previous(key, signature)
            if old:
                return self.view(self.get(old["jobId"]))
            if self.closing or len(self.tasks) >= 2:
                raise agent_manager.Error("Project discovery is busy. Wait for an existing scan to finish")
            job_id = str(uuid.uuid4())
            now = int(time.time() * 1000)
            job = {"id": job_id, "origin": origin, "root": str(raw_path), "requestedRoot": root.strip(),
                   "sourceTurnId": source_turn_id, "sourceCallId": source_call_id,
                   "mode": mode, "includeNested": nested, "exclude": exclude, "state": "queued",
                   "scanComplete": False, "stats": {}, "warnings": [], "reasons": [], "error": None,
                   "registration": None, "revision": 0, "createdAt": now, "updatedAt": now}
            with self.db:
                self.write(job)
                self.journal(key, signature, {"jobId": job_id})
            event = threading.Event()
            self.cancellations[job_id] = event
            task = asyncio.create_task(self.run(job_id, event))
            self.tasks[job_id] = task
            task.add_done_callback(lambda _: (self.tasks.pop(job_id, None), self.cancellations.pop(job_id, None)))
            self.publish(job)
            return self.view(job)

    def progress(self, job_id, update):
        if self.closing:
            return
        job = self.get(job_id)
        if job["state"] != "scanning":
            return
        with self.db:
            for row in update["candidates"]:
                self.db.execute("INSERT OR IGNORE INTO project_candidates VALUES (?,?,?)", (job_id, row["id"], json.dumps(row)))
            job.update({key: update[key] for key in ("root", "stats", "warnings")})
            self.write(job)
        self.publish(job)

    async def run(self, job_id, cancel):
        loop = asyncio.get_running_loop()
        job = self.get(job_id)
        if cancel.is_set():
            return
        job["state"] = "scanning"
        with self.db:
            self.write(job)
        self.publish(job)
        try:
            result = await loop.run_in_executor(self.pool, lambda: self.scan(
                job["root"], job_id, job, cancel,
                lambda value: loop.call_soon_threadsafe(self.progress, job_id, value)))
            # Completion is authoritative even if progress callbacks were delayed.
            # Persist the complete bounded result before any automatic import.
            self.progress(job_id, result)
            job = self.get(job_id)
            job.update({key: result[key] for key in ("root", "stats", "warnings", "reasons", "scanComplete")})
            job["state"] = "interrupted" if self.closing else "cancelled" if cancel.is_set() else "registering" if job["mode"] == "add" else "completed" if result["scanComplete"] else "partial"
            with self.db:
                self.write(job)
            self.publish(job)
            if job["state"] == "registering":
                await self.import_projects({"key": str(uuid.uuid5(uuid.UUID(job_id), "automatic-import")),
                                            "jobId": job_id, "selection": "recommended"}, automatic=True)
        except Exception as error:
            job = self.get(job_id)
            job.update(state="interrupted" if self.closing else "cancelled" if cancel.is_set() else "failed",
                       error=str(error)[:1000] if isinstance(error, (agent_manager.Error, OSError, ValueError)) else "Project discovery failed")
            with self.db:
                self.write(job)
            self.publish(job)

    async def cancel(self, args, origin=None):
        job = self.get(args["jobId"], origin)
        if job["state"] in ("queued", "scanning", "registering"):
            event = self.cancellations.get(job["id"])
            if event:
                event.set()
            job["state"] = "cancelled"
            with self.db:
                self.write(job)
            self.publish(job)
        return self.view(job)

    @staticmethod
    def validate_paths(root, rows):
        accepted, unavailable = [], []
        root = Path(root)
        for row in rows:
            path = Path(row["path"])
            try:
                valid = path.resolve(strict=True) == path and path.is_relative_to(root) and path.is_dir() and os.access(path, os.R_OK | os.X_OK)
            except (OSError, ValueError):
                valid = False
            (accepted if valid else unavailable).append(row)
        return accepted, unavailable

    async def import_projects(self, args, origin=None, *, automatic=False):
        key = identifier(args["key"])
        job = self.get(args["jobId"], origin)
        selection = args.get("selection", "recommended")
        if isinstance(selection, list):
            if not selection or len(selection) > 2000:
                raise agent_manager.Error("Select between 1 and 2000 discovered candidates")
            selection = list(dict.fromkeys(identifier(value) for value in selection))
        elif selection not in ("recommended", "all", "filtered"):
            raise agent_manager.Error("Invalid discovery import selection")
        signature = json.dumps(["project-import", args], sort_keys=True)
        async with self.lock("operation:" + key):
            old = self.previous(key, signature)
            if old:
                return old["job"]
            states = {"completed", "partial", "failed"} | ({"registering"} if automatic else set())
            if self.closing or job["state"] not in states or (job["state"] == "failed" and job.get("errorCode") != "capacity"):
                raise agent_manager.Error("Wait for a completed discovery before importing projects")
            rows = self.candidates(job["id"])
            ids = {row["id"] for row in rows}
            if isinstance(selection, list) and not set(selection) <= ids:
                raise agent_manager.Error("Import selection contains a candidate from another discovery")
            if selection == "filtered":
                selected = self.filtered_candidates(job, self.candidate_views(job))
            else:
                selected = [row for row in rows if selection == "all" or (selection == "recommended" and row["recommended"]) or isinstance(selection, list) and row["id"] in selection]
            eligible, unavailable = await asyncio.get_running_loop().run_in_executor(
                self.pool, self.validate_paths, job["root"], selected)
            async with self.lock("projects:registry"):
                job = self.get(job["id"], origin)
                if self.closing or job["state"] == "cancelled":
                    raise agent_manager.Error("Discovery was stopped before registration")
                # Naming and capacity are recalculated after filesystem validation,
                # immediately before this single transaction, with no RPCs/awaits.
                views = {row["id"]: row for row in self.candidate_views(job)}
                existing, new = [], []
                for row in eligible:
                    current = views[row["id"]]
                    (existing if current["existingProjectIds"] else new).append(current)
                count = self.db.execute("SELECT count(*) FROM projects").fetchone()[0]
                registration = {"selected": len(selected), "added": 0, "existing": len(existing),
                                "unavailable": len(unavailable), "unavailableCandidateIds": [row["id"] for row in unavailable],
                                "capacity": max(0, PROJECT_LIMIT - count), "projectIds": []}
                with self.db:
                    if count + len(new) > PROJECT_LIMIT:
                        job.update(state="failed", errorCode="capacity",
                                   error=f"This import needs {len(new)} project slots; {max(0, PROJECT_LIMIT - count)} are available. Select fewer projects.")
                    else:
                        for row in new:
                            project_id = str(uuid.uuid4())
                            self.db.execute("INSERT INTO projects VALUES (?,?,?)", (project_id, project_name(row["suggestedName"]), row["path"]))
                            registration["projectIds"].append(project_id)
                        registration.update(added=len(new), capacity=max(0, PROJECT_LIMIT - count - len(new)))
                        job.update(state="completed" if job["scanComplete"] and not unavailable else "partial", error=None, errorCode=None)
                    job["registration"] = registration
                    self.write(job)
                    self.journal(key, signature, {"jobId": job["id"], "job": self.view(job)})
                if registration["added"]:
                    self.chats.output({"type": "projects-changed"})
                self.publish(job)
                return self.view(job)

    async def execute(self, op, args):
        if op == "project-list":
            return self.list_projects()
        if op in ("project-files-list", "project-file-read"):
            project_id = identifier(args.get("projectId"))
            row = self.find(project_id)
            if row is None:
                raise agent_manager.Error("Project was not found")
            return {"projectId": project_id, **await asyncio.get_running_loop().run_in_executor(
                self.pool, files.inspect, row["path"], op, args)}
        if op == "project-create":
            async with self.lock("projects:registry"):
                return self.create(args)
        if op == "project-remove":
            return await self.remove(args, {"kind": "ui", "id": "workspace"})
        if op == "project-discovery-start":
            return await self.start(args, {"kind": "ui", "id": "workspace"})
        if op == "project-discovery-get":
            return self.view(self.get(args["jobId"]))
        if op == "project-discovery-list":
            return self.listing(args)
        if op == "project-discovery-results":
            return self.results(args)
        if op == "project-discovery-filter":
            return await self.filter_results(args)
        if op == "project-discovery-cancel":
            return await self.cancel(args)
        if op == "project-import":
            return await self.import_projects(args)
        raise agent_manager.Error("Unknown project operation")

    async def tool(self, name, args, origin, turn_id, call_id=None):
        if name not in TOOL_ARGUMENTS or not isinstance(args, dict) or set(args) - TOOL_ARGUMENTS[name]:
            raise agent_manager.Error("Invalid project tool arguments")
        if name == "add_project":
            return {"project": await self.execute("project-create", args)}
        if name == "remove_project":
            args = {"projectId": identifier(args.get("projectId"))}
        elif name == "discover_projects":
            args = {"root": args.get("root"), "add": args.get("add", False),
                    "includeNested": args.get("includeNested", False), "exclude": args.get("exclude", [])}
            if isinstance(args["root"], str):
                args["root"] = args["root"].strip()
        elif name == "filter_project_discovery":
            args = {"jobId": identifier(args.get("jobId")), **self.normalize_filter(args)}
        elif name == "add_discovered_projects":
            selection = args.get("selection", "recommended")
            if isinstance(selection, list):
                if not 1 <= len(selection) <= 2000:
                    raise agent_manager.Error("Select between 1 and 2000 discovered candidates")
                selection = sorted({identifier(value) for value in selection})
            args = {"jobId": identifier(args.get("jobId")), "selection": selection}
        key = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([origin, turn_id, name, args], sort_keys=True)))
        if name == "remove_project":
            return await self.remove({"key": key, **args}, origin)
        if name == "discover_projects":
            add = args.get("add", False)
            if type(add) is not bool:
                raise agent_manager.Error("add must be a boolean")
            job = await self.start({"key": key, "root": args.get("root"), "mode": "add" if add else "preview",
                                    "includeNested": args.get("includeNested", False), "exclude": args.get("exclude", [])}, origin,
                                   source_turn_id=turn_id, source_call_id=call_id)
            return {**job, "accepted": True, "handoff": "Discovery continues in the backend. Report its current state and finish your reply. The UI receives progress. Inspect only if the user requests progress; never claim all projects were added before completion."}
        if name == "get_project_discovery":
            job = self.get(args["jobId"], origin)
            return {**self.view(job), **self.results({"jobId": job["id"], "offset": args.get("offset", 0), "limit": 20}, origin)}
        if name == "filter_project_discovery":
            job = await self.filter_results({"key": key, **args}, origin)
            return {**job, **self.results({"jobId": job["id"], "limit": 20}, origin)}
        if name == "cancel_project_discovery":
            return await self.cancel(args, origin)
        return await self.import_projects({"key": key, **args}, origin)

    async def close(self):
        self.closing = True
        for event in self.cancellations.values():
            event.set()
        await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)
        self.pool.shutdown(wait=True, cancel_futures=True)
