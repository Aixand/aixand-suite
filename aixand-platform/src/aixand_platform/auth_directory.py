"""Windows authentication storage: private creation and read-only ACL checks."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path
import stat
import sys

from .project_path import PinnedPath
from .windows import kernel, security, sid, protect, verify_private


class SecurityAttributes(c.Structure):
    _fields_ = [('length', w.DWORD), ('descriptor', c.c_void_p), ('inherit', w.BOOL)]


kernel.CreateDirectoryW.argtypes = [w.LPCWSTR, c.POINTER(SecurityAttributes)]


def check(directory):
    # Existing parent ACLs are inspected, never silently repaired.
    with PinnedPath(directory, [], directory=True):
        verify_private(directory)


def create(directory):
    directory = Path(directory).absolute()
    if directory.exists():
        return check(directory)
    if not directory.parent.exists():
        create(directory.parent)
    with PinnedPath(directory.parent, [], directory=True):
        descriptor = c.c_void_p()
        account = sid()
        if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                f'O:{account}D:P(A;OICI;FA;;;{account})', 1, c.byref(descriptor), None):
            raise c.WinError(c.get_last_error())
        try:
            attributes = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor, False)
            if not kernel.CreateDirectoryW(str(directory), c.byref(attributes)):
                error = c.get_last_error()
                if error != 183:  # Another creator must still pass the same ACL checks.
                    raise c.WinError(error)
        finally:
            kernel.LocalFree(descriptor)
        check(directory)


def secure_file(path):
    path = Path(path).absolute()
    with PinnedPath(path.parent, [], directory=True):
        verify_private(path.parent)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_file_attributes & 0x400:
            raise PermissionError('Authentication storage must be a regular private file')
        protect(path)
        verify_private(path)


if __name__ == '__main__':
    action, value = sys.argv[1:]
    {'create': create, 'check': check, 'secure-file': secure_file}[action](Path(value))
