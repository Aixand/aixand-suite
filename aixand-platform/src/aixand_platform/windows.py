"""Windows ACL and retained process identity primitives, using the system APIs."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path

kernel = c.WinDLL("kernel32", use_last_error=True)
security = c.WinDLL("advapi32", use_last_error=True)
kernel.CloseHandle.argtypes = [w.HANDLE]
kernel.LocalFree.argtypes = [w.HLOCAL]
kernel.LocalFree.restype = w.HLOCAL
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.OpenProcess.restype = w.HANDLE
kernel.GetCurrentProcess.restype = w.HANDLE
security.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)]
security.GetTokenInformation.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)]
security.ConvertSidToStringSidW.argtypes = [c.c_void_p, c.POINTER(w.LPWSTR)]
security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p]
security.SetFileSecurityW.argtypes = [w.LPCWSTR, w.DWORD, c.c_void_p]
security.GetNamedSecurityInfoW.argtypes = [w.LPWSTR, c.c_int, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p, c.POINTER(c.c_void_p), c.c_void_p, c.POINTER(c.c_void_p)]
security.GetAce.argtypes = [c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)]
security.EqualSid.argtypes = [c.c_void_p, c.c_void_p]
kernel.GetProcessTimes.argtypes = [w.HANDLE, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)]
kernel.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]


def _check(result):
    if not result:
        raise c.WinError(c.get_last_error())
    return result


def _token_user():
    token = w.HANDLE()
    _check(security.OpenProcessToken(kernel.GetCurrentProcess(), 8, c.byref(token)))
    try:
        size = w.DWORD()
        security.GetTokenInformation(token, 1, None, 0, c.byref(size))
        data = c.create_string_buffer(size.value)
        _check(security.GetTokenInformation(token, 1, data, size, c.byref(size)))
        return data
    finally:
        kernel.CloseHandle(token)


def sid():
    data = _token_user()
    value = w.LPWSTR()
    _check(security.ConvertSidToStringSidW(c.cast(data, c.POINTER(c.c_void_p))[0], c.byref(value)))
    try:
        return value.value
    finally:
        kernel.LocalFree(value)


def protect(path):
    descriptor = c.c_void_p()
    account = sid()
    # Protected DACL; child files/directories inherit the current account only.
    _check(security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
        f"O:{account}D:P(A;OICI;FA;;;{account})", 1, c.byref(descriptor), None))
    try:
        _check(security.SetFileSecurityW(str(Path(path).absolute()), 0x80000005, descriptor))
    finally:
        kernel.LocalFree(descriptor)


def verify_private(path):
    """Reject endpoint descriptors granting any access to another account."""
    owner, acl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
    result = security.GetNamedSecurityInfoW(str(Path(path).absolute()), 1, 5,
        c.byref(owner), None, c.byref(acl), None, c.byref(descriptor))
    if result:
        raise c.WinError(result)
    try:
        user = _token_user()
        user_sid = c.cast(user, c.POINTER(c.c_void_p))[0]
        if not acl.value or not security.EqualSid(owner, user_sid):
            raise PermissionError("Local endpoint must belong to the current account")
        count = c.cast(acl, c.POINTER(c.c_ushort))[2]
        for index in range(count):
            ace = c.c_void_p()
            _check(security.GetAce(acl, index, c.byref(ace)))
            kind = c.cast(ace, c.POINTER(c.c_ubyte))[0]
            if kind == 0 and not security.EqualSid(c.c_void_p(ace.value + 8), user_sid):
                raise PermissionError("Local endpoint grants access to another account")
            if kind not in (0, 1):
                raise PermissionError("Unsupported endpoint access rule")
    finally:
        kernel.LocalFree(descriptor)


def process_start(pid):
    handle = kernel.OpenProcess(0x100000 | 0x1000, False, int(pid))
    if not handle:
        return None
    try:
        if kernel.WaitForSingleObject(handle, 0) != 258:
            return None
        values = [w.FILETIME() for _ in range(4)]
        _check(kernel.GetProcessTimes(handle, *[c.byref(value) for value in values]))
        return str(values[0].dwLowDateTime | values[0].dwHighDateTime << 32)
    finally:
        kernel.CloseHandle(handle)
