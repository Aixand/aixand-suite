"""Read-only, bounded project discovery. No database or agent dependencies."""
from collections import deque
import fnmatch
import json
import os
from pathlib import Path
import stat
import time
import tomllib
import uuid


IGNORED = frozenset({
    ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
    ".venv", "venv", ".tox", "__pycache__", "target", "dist", "build",
    "coverage", "artifacts", "test-results", "playwright-report", ".cache",
    ".next", ".nuxt", ".yarn", ".pnpm-store", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".pathspec", ".sonar", ".lore", ".aixand",
})
MANIFESTS = frozenset({
    "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml",
    "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "mix.exs",
    "pubspec.yaml", "CMakeLists.txt",
})
LIMITS = {"depth": 32, "directories": 100_000, "candidates": 2_000,
          "entries": 1_000_000, "seconds": 120, "metadataBytes": 65_536}
ROOT_MARKERS = frozenset({".git", ".pathspec/manifest.yaml", ".aixand/project.json"})


def open_directory(directory):
    """Walk absolute components with openat; never follow an ancestor link."""
    flags = os.O_DIRECTORY | os.O_NOFOLLOW
    parts = directory.parts[1:]
    fd = os.open(directory.anchor, flags | (getattr(os, "O_PATH", os.O_RDONLY) if parts else os.O_RDONLY))
    try:
        for index, part in enumerate(parts):
            child = os.open(part, flags | (os.O_RDONLY if index == len(parts) - 1 else getattr(os, "O_PATH", os.O_RDONLY)), dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_metadata(directory_fd, directory, name, limit):
    """Refuse links, special files and oversized metadata before reading."""
    if os.name == "nt":
        from aixand_filesystem import PinnedPath
        with PinnedPath(directory, [name]) as selected:
            info = os.fstat(selected.file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise ValueError("Metadata is not a regular file within the size limit")
            data = selected.file.read(limit + 1)
            if len(data) > limit:
                raise ValueError("Metadata exceeded the size limit")
            return data.decode("utf-8")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(name if directory_fd is not None else directory / name,
                 flags, **({"dir_fd": directory_fd} if directory_fd is not None else {}))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("Metadata is not a regular file within the size limit")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Metadata exceeded the size limit")
        return data.decode("utf-8")


def project_marker(text, directory):
    """Explicit roots can group member projects even when members have Git roots."""
    value = json.loads(text)
    if not isinstance(value, dict) or value.get("schema") != "aixand/project-1":
        raise ValueError("Expected an aixand/project-1 marker")
    name = value.get("name")
    if name is not None and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 128 or
                             any(ord(char) < 32 for char in name)):
        raise ValueError("Invalid project marker name")
    members = value.get("members", [])
    if not isinstance(members, list) or len(members) > 2000:
        raise ValueError("Invalid project marker members")
    paths = set()
    for member in members:
        if not isinstance(member, str) or not 1 <= len(member) <= 4096 or "\x00" in member:
            raise ValueError("Invalid project marker member path")
        path = Path(member)
        if path.is_absolute() or not path.parts or ".." in path.parts:
            raise ValueError("Project marker members must be relative paths within the project")
        paths.add(directory / path)
    return name.strip() if name else None, frozenset(paths)


def scan(root, job_id, options, cancel, emit=lambda value: None, *, limits=None):
    bounds = {**LIMITS, **(limits or {})}
    started = time.monotonic()
    stats = {"directories": 0, "entries": 0, "candidates": 0, "nested": 0,
             "excluded": 0, "symlinks": 0, "warnings": 0}
    warnings, candidates, batch, reasons = [], [], [], set()
    last_emit = started
    root = Path(root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Discovery root must be an existing directory")
    stack = deque([(root, 0, None, frozenset())])

    def warning(path, code, message):
        stats["warnings"] += 1
        reasons.add(code)
        if len(warnings) < 50:
            warnings.append({"path": str(path), "code": code, "message": message})

    def progress(force=False):
        nonlocal batch, last_emit
        now = time.monotonic()
        if force or len(batch) >= 100 or now - last_emit >= 0.5:
            emit({"root": str(root), "stats": dict(stats), "warnings": list(warnings),
                  "candidates": batch})
            batch, last_emit = [], now

    def interrupted():
        if cancel.is_set():
            return True
        if time.monotonic() - started >= bounds["seconds"]:
            reasons.add("time-limit")
            return True
        return False

    while stack and not interrupted():
        if stats["directories"] >= bounds["directories"]:
            reasons.add("directory-limit")
            break
        directory, depth, parent, members = stack.popleft()
        fd = None
        try:
            # On POSIX, opening the directory without following links also protects
            # against a directory being replaced by a link between stat and scan.
            if os.scandir in os.supports_fd:
                fd = open_directory(directory)
            elif directory.is_symlink() or not directory.resolve(strict=True).is_relative_to(root):
                raise ValueError("Directory moved outside the discovery root")
            files, folders = set(), []
            stats["directories"] += 1
            with os.scandir(fd if fd is not None else directory) as stream:
                for entry in stream:
                    stats["entries"] += 1
                    if stats["entries"] > bounds["entries"]:
                        reasons.add("entry-limit")
                        break
                    if interrupted():
                        break
                    if entry.is_symlink() or getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x400:
                        stats["symlinks"] += 1
                    elif entry.is_dir(follow_symlinks=False):
                        folders.append(entry.name)
                    elif entry.is_file(follow_symlinks=False):
                        files.add(entry.name)
            if cancel.is_set() or "entry-limit" in reasons or "time-limit" in reasons:
                break
            signals = []
            marker_name, marker_members = None, None
            if ".git" in folders:
                signals.append(".git")
            if ".git" in files:
                try:
                    if read_metadata(fd, directory, ".git", bounds["metadataBytes"]).strip().startswith("gitdir:"):
                        signals.append(".git")
                    else:
                        warning(directory / ".git", "invalid-metadata", "Git worktree marker is invalid")
                except (OSError, ValueError, UnicodeError):
                    warning(directory / ".git", "unreadable-metadata", "Git worktree marker could not be read")
            if ".pathspec" in folders:
                sub_fd = None
                try:
                    if fd is not None:
                        sub_fd = os.open(".pathspec", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    marker = directory / ".pathspec" / "manifest.yaml"
                    if sub_fd is not None or not marker.is_symlink() and marker.is_file():
                        read_metadata(sub_fd, directory / ".pathspec", "manifest.yaml", bounds["metadataBytes"])
                        signals.append(".pathspec/manifest.yaml")
                except FileNotFoundError:
                    pass
                except (OSError, ValueError, UnicodeError):
                    warning(directory / ".pathspec", "invalid-metadata", "Pathspec marker could not be inspected within the size limit")
                finally:
                    if sub_fd is not None:
                        os.close(sub_fd)
            if ".aixand" in folders:
                sub_fd = None
                try:
                    if fd is not None:
                        sub_fd = os.open(".aixand", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    marker_name, marker_members = project_marker(
                        read_metadata(sub_fd, directory / ".aixand", "project.json", bounds["metadataBytes"]), directory)
                    signals.append(".aixand/project.json")
                except FileNotFoundError:
                    pass
                except (OSError, ValueError, UnicodeError, RecursionError):
                    warning(directory / ".aixand/project.json", "invalid-metadata", "Project root marker could not be read or parsed within the size limit")
                finally:
                    if sub_fd is not None:
                        os.close(sub_fd)
            for name in sorted(files):
                if interrupted():
                    break
                if name not in MANIFESTS and not name.lower().endswith((".csproj", ".fsproj", ".vbproj", ".sln", ".slnx")):
                    continue
                try:
                    text = read_metadata(fd, directory, name, bounds["metadataBytes"])
                    if name in ("package.json", "composer.json") and not isinstance(json.loads(text), dict):
                        raise ValueError("Expected a manifest object")
                    if name in ("Cargo.toml", "pyproject.toml"):
                        document = tomllib.loads(text)
                        if name == "Cargo.toml" and not ({"package", "workspace"} & document.keys()):
                            raise ValueError("Expected a Cargo package or workspace")
                    if name == "go.mod" and not any(line.strip().startswith("module ") for line in text.splitlines()):
                        raise ValueError("Expected a Go module declaration")
                    signals.append(name)
                except (OSError, ValueError, UnicodeError, RecursionError):
                    warning(directory / name, "invalid-metadata", "Project metadata could not be read or parsed within the size limit")
            nearest = parent
            if signals:
                if len(candidates) >= bounds["candidates"]:
                    reasons.add("candidate-limit")
                    break
                identifier = str(uuid.uuid5(uuid.UUID(job_id), str(directory)))
                nested = parent is not None and (directory in members or not (ROOT_MARKERS & set(signals)))
                name = marker_name or "".join(char for char in directory.name if ord(char) >= 32).strip()[:128] or "Project"
                row = {"id": identifier, "path": str(directory), "suggestedName": name,
                       "signals": signals, "classification": "nested" if nested else "root",
                       "parentCandidateId": parent, "recommended": not nested or options.get("includeNested", False)}
                candidates.append(row)
                batch.append(row)
                stats["candidates"] += 1
                stats["nested"] += int(nested)
                nearest = identifier
            for name in sorted(folders):
                if interrupted():
                    break
                child = directory / name
                relative = child.relative_to(root).as_posix()
                excluded = name in IGNORED or any(
                    fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(name, pattern)
                    for pattern in options.get("exclude", []))
                if excluded:
                    stats["excluded"] += 1
                elif depth >= bounds["depth"]:
                    reasons.add("depth-limit")
                elif len(stack) + stats["directories"] >= bounds["directories"]:
                    reasons.add("directory-limit")
                else:
                    stack.append((child, depth + 1, nearest, marker_members if marker_members is not None else members))
        except (OSError, ValueError):
            if directory == root:
                raise ValueError("Discovery root is not accessible") from None
            warning(directory, "unreadable-directory", "Directory could not be inspected")
        finally:
            if fd is not None:
                os.close(fd)
        progress()
    progress(force=True)
    return {"root": str(root), "stats": stats, "warnings": warnings,
            "candidates": candidates,
            "reasons": sorted(reasons), "scanComplete": not reasons and not cancel.is_set(),
            "cancelled": cancel.is_set()}
