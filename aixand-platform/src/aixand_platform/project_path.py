"""Windows project traversal with pinned ancestors and no reparse-point reads.

Directory handles omit FILE_SHARE_DELETE so an ancestor cannot be renamed or
replaced while the selected file is inspected. Every component is opened with
OPEN_REPARSE_POINT before it is trusted.
"""
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
from .windows import kernel

kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
kernel.CreateFileW.restype = w.HANDLE
kernel.GetFileInformationByHandle.argtypes = [w.HANDLE, c.c_void_p]


class PinnedPath:
    def __init__(self, root, parts, *, directory=False):
        self.path = Path(root).absolute().joinpath(*parts)
        self.directory = directory
        self.handles = []
        self.file = None

    def __enter__(self):
        import msvcrt
        parts = self.path.parts
        try:
            for index in range(len(parts)):
                current = Path(*parts[:index + 1])
                if index and (":" in parts[index] or parts[index] in (".", "..") or parts[index].rstrip(" .") != parts[index]):
                    raise PermissionError("Invalid Windows project path")
                handle = kernel.CreateFileW(str(current), 0x80000000, 3, None, 3, 0x02000000 | 0x00200000, None)
                if handle == w.HANDLE(-1).value:
                    raise c.WinError(c.get_last_error())
                self.handles.append(handle)
                info = c.create_string_buffer(52)
                if not kernel.GetFileInformationByHandle(handle, info):
                    raise c.WinError(c.get_last_error())
                attributes = c.cast(info, c.POINTER(w.DWORD))[0]
                if attributes & 0x400:
                    raise PermissionError("Linked project paths cannot be opened")
                if index < len(parts) - 1 or self.directory:
                    if not attributes & 0x10:
                        raise NotADirectoryError(str(current))
            if not self.directory:
                handle = self.handles.pop()
                descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
                self.file = os.fdopen(descriptor, "rb")
            return self
        except BaseException:
            self.__exit__()
            raise

    def __exit__(self, *_):
        if self.file:
            self.file.close()
        for handle in reversed(self.handles):
            kernel.CloseHandle(handle)
        self.handles.clear()
