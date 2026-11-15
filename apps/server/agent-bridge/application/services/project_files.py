"""Bounded, read-only file browsing beneath a registered local project."""
import contextlib
import base64
import os
import stat

import agent_manager

MAX_ENTRIES = 5000
TEXT_BYTES = 256 * 1024
IMAGE_BYTES = 512 * 1024


def components(path):
    if not isinstance(path, str) or len(path.encode("utf-8", errors="surrogatepass")) > 4096:
        raise agent_manager.Error("Invalid project-relative path")
    if path == "":
        return []
    parts = path.split("/")
    if "\\" in path or any(part in ("", ".", "..") for part in parts) or any(ord(c) < 32 or ord(c) == 127 for c in path):
        raise agent_manager.Error("Choose a path inside the project")
    return parts


def open_path(root, path, *, directory=False):
    """Open every component without following links, including during renames."""
    parts = components(path)
    folder_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open(root, folder_flags)
    try:
        for index, part in enumerate(parts):
            flags = folder_flags if directory or index < len(parts) - 1 else os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            following = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


@contextlib.contextmanager
def directory_handle(root, path):
    if os.name == "nt":
        from aixand_filesystem import PinnedPath
        with PinnedPath(root, components(path), directory=True) as selected:
            yield selected.path
    else:
        descriptor = open_path(root, path, directory=True)
        try:
            yield descriptor
        finally:
            os.close(descriptor)


@contextlib.contextmanager
def file_handle(root, path):
    if os.name == "nt":
        from aixand_filesystem import PinnedPath
        with PinnedPath(root, components(path)) as selected:
            yield selected.file
    else:
        with os.fdopen(open_path(root, path), "rb") as stream:
            yield stream


def list_directory(root, path="", *, offset=0, limit=100, hidden=False):
    if type(offset) is not int or not 0 <= offset < MAX_ENTRIES or type(limit) is not int or not 1 <= limit <= 200 or type(hidden) is not bool:
        raise agent_manager.Error("Invalid project file listing")
    with directory_handle(root, path) as descriptor:
        entries, limited = [], False
        with os.scandir(descriptor) as directory:
            for scanned, entry in enumerate(directory):
                if scanned >= MAX_ENTRIES:
                    limited = True
                    break
                if not hidden and entry.name.startswith("."):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue  # Files may disappear while an agent is working.
                kind = "link" if getattr(info, "st_file_attributes", 0) & 0x400 else "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "link" if stat.S_ISLNK(info.st_mode) else "other"
                relative = path + "/" + entry.name if path else entry.name
                try:
                    components(relative)
                    supported = kind in ("directory", "file")
                except agent_manager.Error:
                    supported = False
                entries.append({"name": entry.name, "path": relative, "kind": kind,
                                "size": info.st_size, "modifiedAt": info.st_mtime * 1000, "supported": supported})
        entries.sort(key=lambda entry: (entry["kind"] != "directory", entry["name"].casefold(), entry["name"]))
        page = entries[offset:offset + limit]
        return {"path": path, "entries": page, "total": len(entries), "limited": limited,
                "nextOffset": offset + len(page) if offset + len(page) < len(entries) else None}


def image_mime(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def read_file(root, path):
    if not components(path):
        raise agent_manager.Error("Choose a project file")
    with file_handle(root, path) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise agent_manager.Error("Only regular project files can be previewed")
        data = stream.read(IMAGE_BYTES + 1)
    result = {"path": path, "name": path.rsplit("/", 1)[-1], "size": info.st_size,
              "modifiedAt": info.st_mtime * 1000, "truncated": False}
    mime = image_mime(data)
    if mime:
        if len(data) > IMAGE_BYTES:
            return {**result, "kind": "unsupported", "message": "This image exceeds the 512 KiB preview limit."}
        return {**result, "kind": "image", "mime": mime, "content": base64.b64encode(data).decode("ascii")}
    preview = data[:TEXT_BYTES]
    truncated = len(data) > TEXT_BYTES
    try:
        # An incremental decoder permits a multibyte character at the preview boundary.
        import codecs
        text = codecs.getincrementaldecoder("utf-8-sig")().decode(preview, final=not truncated)
        if any(ord(c) < 32 and c not in "\n\r\t\f" for c in text):
            raise UnicodeError()
    except UnicodeError:
        return {**result, "kind": "unsupported", "message": "A preview is unavailable for this binary or non-UTF-8 file."}
    return {**result, "kind": "text", "content": text, "truncated": truncated}


def inspect(root, op, args):
    try:
        if op == "project-files-list":
            return list_directory(root, args.get("path", ""), offset=args.get("offset", 0),
                                  limit=args.get("limit", 100), hidden=args.get("hidden", False))
        return read_file(root, args.get("path"))
    except PermissionError:
        raise agent_manager.Error("This project path is not readable") from None
    except FileNotFoundError:
        raise agent_manager.Error("This project path no longer exists. Refresh the files.") from None
    except OSError:
        raise agent_manager.Error("This path is unavailable. Linked paths and special files cannot be opened.") from None
