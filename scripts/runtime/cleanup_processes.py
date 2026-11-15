"""Find users of selected cleanup paths; stop only freshly reviewed identities.

No process-name matching, process-tree kills, shell commands, or file deletion.
Windows uses Restart Manager and native handles; POSIX uses open-file evidence.
"""
from contextlib import contextmanager, ExitStack
import base64
import ctypes as c
import json
import os
import re
from pathlib import Path, PureWindowsPath
import signal
import stat
import struct
import subprocess
import sys
import time

from aixand_local_runtime import process_start


def display_path(path):
    """Keep extended Windows filesystem names out of review identities/UI."""
    value = os.fspath(path)
    if os.name == 'nt':
        if value.startswith('\\\\?\\UNC\\'):
            value = '\\\\' + value[8:]
        elif value.startswith('\\\\?\\'):
            value = value[4:]
    return Path(value)


def filesystem_path(path):
    """Windows directory enumeration also appends a wildcard to the path.

    A directory can stat successfully and still fail enumeration near MAX_PATH.
    Use extended names for all filesystem operations, including short roots
    whose descendants can exceed that limit. Review paths stay conventional.
    """
    path = Path(path)
    if os.name != 'nt':
        return path
    value = os.path.abspath(path)
    if not value.startswith('\\\\?\\'):
        value = '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return Path(value)


def redirected(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def file_identity(path):
    if os.name == 'nt':
        kernel = c.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [c.c_wchar_p, c.c_uint32, c.c_uint32, c.c_void_p, c.c_uint32, c.c_uint32, c.c_void_p]
        kernel.CreateFileW.restype = c.c_void_p
        kernel.GetFileInformationByHandle.argtypes = [c.c_void_p, c.c_void_p]
        kernel.CloseHandle.argtypes = [c.c_void_p]
        # A metadata-only handle remains available when reading file contents
        # or DELETE access is denied. Do not substitute a missing file ID.
        handle = kernel.CreateFileW(str(filesystem_path(path)), 0x80, 7, None, 3, 0x02200000, None)
        if handle == c.c_void_p(-1).value:
            if c.get_last_error() == 5:
                return directory_entry_identity(Path(path), kernel)
            raise c.WinError(c.get_last_error())
        try:
            info = (c.c_uint32 * 13)()
            if not kernel.GetFileInformationByHandle(handle, info):
                if c.get_last_error() == 5:
                    return directory_entry_identity(Path(path), kernel)
                raise c.WinError(c.get_last_error())
            directory = bool(info[0] & 0x10)
            if info[0] & 0x400 or not directory and info[10] != 1:
                raise ValueError('Permission repair cannot follow links or files with additional hard links.')
            return dict(device=str(info[7]), file=str(info[11] << 32 | info[12]),
                        modified=str((info[5] | info[6] << 32) * 100), size=str(info[8] << 32 | info[9]), directory=directory)
        finally:
            kernel.CloseHandle(handle)
    info = filesystem_path(path).lstat()
    if redirected(info) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError('Permission repair cannot follow links or special files.')
    if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
        raise ValueError('Permission repair cannot change a file with additional hard links.')
    return dict(device=str(info.st_dev), file=str(info.st_ino), modified=str(info.st_mtime_ns),
                size=str(info.st_size), directory=stat.S_ISDIR(info.st_mode))


def directory_entry_identity(path, kernel):
    """Read the real file ID through its readable parent when its ACL denies opens."""
    kernel.GetFileInformationByHandleEx.argtypes = [c.c_void_p, c.c_int, c.c_void_p, c.c_uint32]
    handle = kernel.CreateFileW(str(filesystem_path(path.parent)), 0x81, 7, None, 3, 0x02200000, None)
    if handle == c.c_void_p(-1).value:
        raise c.WinError(c.get_last_error())
    try:
        parent = (c.c_uint32 * 13)()
        if not kernel.GetFileInformationByHandle(handle, parent):
            raise c.WinError(c.get_last_error())
        if parent[0] & 0x400:
            raise ValueError('Permission repair cannot inspect a linked parent.')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            buffer = c.create_string_buffer(65536)
            if not kernel.GetFileInformationByHandleEx(handle, 10, buffer, len(buffer)):
                raise c.WinError(c.get_last_error())
            data, offset = buffer.raw, 0
            while True:
                next_offset, _index, _created, _accessed, modified, _changed, size, _allocated, attributes, length = struct.unpack_from('<IIqqqqqqII', data, offset)
                name = data[offset + 104:offset + 104 + length].decode('utf-16le')
                if name.casefold() == path.name.casefold():
                    if attributes & 0x400:
                        raise ValueError('Permission repair cannot follow links.')
                    return dict(device=str(parent[7]), file=str(struct.unpack_from('<Q', data, offset + 96)[0]),
                                modified=str(modified * 100), size=str(size), directory=bool(attributes & 0x10))
                if not next_offset:
                    break
                offset += next_offset
        raise ValueError('Reading the reviewed file identity took too long.')
    finally:
        kernel.CloseHandle(handle)


def permission_scope(profile, base, target):
    """The elevated job only restores access inside the original user's data."""
    path, component = Path(target['path']), target['component']
    if (not profile.is_absolute() or not base.is_absolute() or base == profile or
            not base.is_relative_to(profile) or not path.is_absolute() or path == profile or
            not path.is_relative_to(profile) or any(part in ('.', '..') for part in path.parts)):
        return False
    if component in ('workspace', 'provider-accounts', 'provider-runtime', 'provider-tool-store'):
        if component == 'provider-accounts' and path.is_relative_to(base / 'agents/provider-sdks'):
            return False
        if component == 'workspace' and any(path == root or path.is_relative_to(root) for root in
                [base / 'agents', base / 'tools', base / 'config/providers.toml',
                 *[base / kind / 'opencode' for kind in ('data', 'config', 'state', 'cache')]]):
            return False
        roots = {'workspace': [base], 'provider-accounts': [base / 'agents', base / 'config/providers.toml',
                    *[base / kind / 'opencode' for kind in ('data', 'config', 'state', 'cache')]],
                 'provider-runtime': [base / 'agents/provider-sdks'],
                 'provider-tool-store': [base / 'tools', base / 'state/agent-manager']}[component]
        return any(path == root or path.is_relative_to(root) for root in roots)
    if component.startswith('provider:'):
        return path.is_relative_to(base / 'tools')
    if component.startswith('native:') and path.is_relative_to(base):
        return False
    if component == 'native:codex':
        return (path.is_relative_to(profile / '.codex') and not path.is_relative_to(profile / '.codex/packages')
                and not (path.name.startswith('.codex-provisioning-') and path.name.endswith('.guard')))
    if component == 'native:claude':
        return path.is_relative_to(profile / '.claude') or path.parent == profile and (
            path.name == '.claude.json' or path.name.startswith('.claude.json.backup'))
    if component == 'native:opencode':
        return any(part.casefold() == 'opencode' for part in path.relative_to(profile).parts[:-1]) or path.name.casefold() == 'opencode'
    return False


def permission_review(report, targets, base, profile):
    review = []
    if os.name == 'nt':
        for error in report['errors']:
            if error.get('winerror') != 5:
                continue
            path = Path(error['path'])
            for target in targets:
                root = Path(target['path'])
                if (path == root or path.is_relative_to(root)) and permission_scope(profile, base, target):
                    try:
                        item = dict(component=target['component'], path=str(path), identity=file_identity(path))
                        if item not in review:
                            review.append(item)
                    except (OSError, ValueError):
                        pass
                    break
    return dict(report, permissionReview=review[:16], permissionRemaining=max(0, len(review) - 16),
                canRepairPermissions=True) if review else report


def normalize_targets(targets):
    result = []
    for target in targets:
        path = Path(target['path'])
        if not path.is_absolute() or path == Path(path.anchor) or '\0' in str(path):
            raise ValueError('Invalid process cleanup target')
        for parent in path.parents:
            try:
                if redirected(filesystem_path(parent).lstat()):
                    raise ValueError('Process cleanup cannot inspect a redirected directory: ' + str(parent))
            except FileNotFoundError:
                pass
        if not any(value['component'] == target['component'] and
                   path.is_relative_to(Path(value['path'])) for value in result):
            result.append(dict(component=target['component'], path=str(path)))
    return result


def regular_files(root, deadline, *, include_directories=False):
    pending, visited = [filesystem_path(root)], 0
    while pending:
        if time.monotonic() > deadline or visited > 300_000:
            raise ValueError('Checking selected files took too long. Select fewer components and retry.')
        path = pending.pop()
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        visited += 1
        if redirected(info):
            continue  # Removing a link does not require stopping its target.
        if stat.S_ISDIR(info.st_mode):
            if include_directories:
                yield display_path(path), info
            try:
                pending.extend(path.iterdir())
            except FileNotFoundError:
                continue  # A selected temporary directory may already be gone.
        elif stat.S_ISREG(info.st_mode):
            yield display_path(path), info


class FILETIME(c.Structure):
    _fields_ = [('low', c.c_uint32), ('high', c.c_uint32)]

    def number(self):
        return self.low | self.high << 32


class UNIQUE_PROCESS(c.Structure):
    _fields_ = [('pid', c.c_uint32), ('start', FILETIME)]


class PROCESS_INFO(c.Structure):
    _fields_ = [('process', UNIQUE_PROCESS), ('name', c.c_wchar * 256),
                ('service', c.c_wchar * 64), ('kind', c.c_int),
                ('status', c.c_uint32), ('session', c.c_uint32), ('restartable', c.c_int)]


class SERVICE_STATUS(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in ('kind', 'state', 'controls', 'exit', 'specific', 'checkpoint', 'hint')]


class SERVICE_STATUS_PROCESS(c.Structure):
    _fields_ = SERVICE_STATUS._fields_ + [('pid', c.c_uint32), ('flags', c.c_uint32)]


class LUID(c.Structure):
    _fields_ = [('low', c.c_uint32), ('high', c.c_int32)]


class TOKEN_PRIVILEGES(c.Structure):
    # Exactly one privilege is adjusted and restored; this is not a request
    # to enable every privilege in the administrator's token.
    _fields_ = [('count', c.c_uint32), ('luid', LUID), ('attributes', c.c_uint32)]


class SHELL_EXECUTE_INFO(c.Structure):
    _fields_ = [('size', c.c_uint32), ('mask', c.c_uint32), ('window', c.c_void_p),
                ('verb', c.c_wchar_p), ('file', c.c_wchar_p), ('parameters', c.c_wchar_p),
                ('directory', c.c_wchar_p), ('show', c.c_int), ('instance', c.c_void_p),
                ('idlist', c.c_void_p), ('class_name', c.c_wchar_p), ('class_key', c.c_void_p),
                ('hotkey', c.c_uint32), ('icon', c.c_void_p), ('process', c.c_void_p)]


CODEX_SERVICE = 'CodexSandboxService.OpenAI.Codex'


def codex_service_image(executable):
    """Only the observed Store-owned Codex sandbox service gets elevation."""
    parts = PureWindowsPath(executable).parts
    return (len(parts) == 7 and parts[1].casefold() == 'program files' and parts[2].casefold() == 'windowsapps'
            and parts[3].casefold().startswith('openai.codex_') and parts[3].casefold().endswith('__2p2nqsd0c76g0')
            and tuple(value.casefold() for value in parts[4:]) == ('app', 'resources', 'codex-windows-sandbox-service.exe'))


class Windows:
    def __init__(self, protected):
        self.protected = set(protected) | {os.getpid(), os.getppid(), 0, 4}
        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.security = c.WinDLL('advapi32', use_last_error=True)
        self.rm = c.WinDLL('rstrtmgr', use_last_error=True)
        self.bind(self.kernel, 'OpenProcess', [c.c_uint32, c.c_int, c.c_uint32], c.c_void_p)
        self.bind(self.kernel, 'CloseHandle', [c.c_void_p], c.c_int)
        self.bind(self.kernel, 'WaitForSingleObject', [c.c_void_p, c.c_uint32], c.c_uint32)
        self.bind(self.kernel, 'GetProcessTimes', [c.c_void_p, *([c.POINTER(FILETIME)] * 4)], c.c_int)
        self.bind(self.kernel, 'QueryFullProcessImageNameW', [c.c_void_p, c.c_uint32, c.c_wchar_p, c.POINTER(c.c_uint32)], c.c_int)
        self.bind(self.kernel, 'GetShortPathNameW', [c.c_wchar_p, c.c_wchar_p, c.c_uint32], c.c_uint32)
        self.bind(self.kernel, 'ProcessIdToSessionId', [c.c_uint32, c.POINTER(c.c_uint32)], c.c_int)
        self.bind(self.kernel, 'IsProcessCritical', [c.c_void_p, c.POINTER(c.c_int)], c.c_int)
        self.bind(self.kernel, 'TerminateProcess', [c.c_void_p, c.c_uint32], c.c_int)
        self.bind(self.kernel, 'GetExitCodeProcess', [c.c_void_p, c.POINTER(c.c_uint32)], c.c_int)
        self.bind(self.kernel, 'CreateFileW', [c.c_wchar_p, c.c_uint32, c.c_uint32, c.c_void_p,
                  c.c_uint32, c.c_uint32, c.c_void_p], c.c_void_p)
        self.bind(self.security, 'OpenProcessToken', [c.c_void_p, c.c_uint32, c.POINTER(c.c_void_p)], c.c_int)
        self.bind(self.security, 'LookupPrivilegeValueW', [c.c_wchar_p, c.c_wchar_p, c.POINTER(LUID)], c.c_int)
        self.bind(self.security, 'AdjustTokenPrivileges', [c.c_void_p, c.c_int, c.POINTER(TOKEN_PRIVILEGES),
                  c.c_uint32, c.POINTER(TOKEN_PRIVILEGES), c.POINTER(c.c_uint32)], c.c_int)
        self.bind(self.security, 'GetTokenInformation', [c.c_void_p, c.c_int, c.c_void_p,
                  c.c_uint32, c.POINTER(c.c_uint32)], c.c_int)
        self.bind(self.security, 'GetLengthSid', [c.c_void_p], c.c_uint32)
        self.bind(self.security, 'OpenSCManagerW', [c.c_wchar_p, c.c_wchar_p, c.c_uint32], c.c_void_p)
        self.bind(self.security, 'OpenServiceW', [c.c_void_p, c.c_wchar_p, c.c_uint32], c.c_void_p)
        self.bind(self.security, 'CloseServiceHandle', [c.c_void_p], c.c_int)
        self.bind(self.security, 'QueryServiceStatusEx', [c.c_void_p, c.c_int, c.c_void_p, c.c_uint32, c.POINTER(c.c_uint32)], c.c_int)
        self.bind(self.security, 'ControlService', [c.c_void_p, c.c_uint32, c.POINTER(SERVICE_STATUS)], c.c_int)
        self.bind(self.rm, 'RmStartSession', [c.POINTER(c.c_uint32), c.c_uint32, c.c_wchar_p])
        self.bind(self.rm, 'RmEndSession', [c.c_uint32])
        self.bind(self.rm, 'RmRegisterResources', [c.c_uint32, c.c_uint32, c.POINTER(c.c_wchar_p),
                  c.c_uint32, c.POINTER(UNIQUE_PROCESS), c.c_uint32, c.POINTER(c.c_wchar_p)])
        self.bind(self.rm, 'RmGetList', [c.c_uint32, c.POINTER(c.c_uint32), c.POINTER(c.c_uint32),
                  c.POINTER(PROCESS_INFO), c.POINTER(c.c_uint32)])
        self.bind(self.rm, 'RmShutdown', [c.c_uint32, c.c_uint32, c.c_void_p])
        with self.handle(os.getpid()) as handle:
            self.user = self.user_of(handle)
        self.session = self.session_of(os.getpid())

    @staticmethod
    def bind(library, name, args, result=c.c_uint32):
        function = getattr(library, name)
        function.argtypes, function.restype = args, result

    @contextmanager
    def handle(self, pid, terminate=False):
        handle = self.kernel.OpenProcess(0x100000 | 0x1000 | (1 if terminate else 0), False, pid)
        if not handle:
            raise c.WinError(c.get_last_error())
        try:
            yield handle
        finally:
            self.kernel.CloseHandle(handle)

    def user_of(self, process):
        token = c.c_void_p()
        if not self.security.OpenProcessToken(process, 8, c.byref(token)):
            raise c.WinError(c.get_last_error())
        try:
            size = c.c_uint32()
            self.security.GetTokenInformation(token, 1, None, 0, c.byref(size))
            if not size.value:
                raise c.WinError(c.get_last_error())
            buffer = c.create_string_buffer(size.value)
            if not self.security.GetTokenInformation(token, 1, buffer, size, c.byref(size)):
                raise c.WinError(c.get_last_error())
            sid = c.cast(buffer, c.POINTER(c.c_void_p))[0]
            return c.string_at(sid, self.security.GetLengthSid(sid))
        finally:
            self.kernel.CloseHandle(token)

    def service_inspection_privilege(self):
        return self.token_privilege('SeDebugPrivilege')

    @contextmanager
    def token_privilege(self, name):
        # UAC elevation leaves SeDebugPrivilege disabled. Codex's LocalSystem
        # service denies process inspection even to this elevated token until
        # its existing privilege is enabled. Use it only in the dedicated
        # reviewed-service helper, and restore its previous state on exit.
        token = c.c_void_p()
        with self.handle(os.getpid()) as handle:
            if not self.security.OpenProcessToken(handle, 0x28, c.byref(token)):
                raise c.WinError(c.get_last_error())
        previous, requested, size = TOKEN_PRIVILEGES(), TOKEN_PRIVILEGES(), c.c_uint32()
        adjusted = False
        try:
            requested.count, requested.attributes = 1, 2
            if not self.security.LookupPrivilegeValueW(None, name, c.byref(requested.luid)):
                raise c.WinError(c.get_last_error())
            c.set_last_error(0)
            if not self.security.AdjustTokenPrivileges(token, False, c.byref(requested), c.sizeof(previous),
                                                      c.byref(previous), c.byref(size)):
                raise c.WinError(c.get_last_error())
            adjusted = True
            error = c.get_last_error()
            if error:
                # TRUE with ERROR_NOT_ALL_ASSIGNED is not success. Never
                # proceed with service control when the privilege is absent.
                raise c.WinError(error)
            yield
        finally:
            try:
                if adjusted and previous.count:
                    c.set_last_error(0)
                    if not self.security.AdjustTokenPrivileges(token, False, c.byref(previous), 0, None, None):
                        raise c.WinError(c.get_last_error())
                    if c.get_last_error():
                        raise c.WinError(c.get_last_error())
            finally:
                self.kernel.CloseHandle(token)

    def session_of(self, pid):
        session = c.c_uint32()
        if not self.kernel.ProcessIdToSessionId(pid, c.byref(session)):
            raise c.WinError(c.get_last_error())
        return session.value

    def identity(self, pid, handle=None):
        if handle is None:
            with self.handle(pid) as opened:
                return self.identity(pid, opened)
        if self.kernel.WaitForSingleObject(handle, 0) != 258:
            return None
        times = [FILETIME() for _ in range(4)]
        if not self.kernel.GetProcessTimes(handle, *[c.byref(value) for value in times]):
            raise c.WinError(c.get_last_error())
        name, size = c.create_unicode_buffer(32768), c.c_uint32(32768)
        if not self.kernel.QueryFullProcessImageNameW(handle, 0, name, c.byref(size)):
            raise c.WinError(c.get_last_error())
        critical = c.c_int()
        if not self.kernel.IsProcessCritical(handle, c.byref(critical)):
            raise c.WinError(c.get_last_error())
        allowed = (pid not in self.protected and not critical.value and
                   self.session_of(pid) == self.session and self.user_of(handle) == self.user)
        return dict(pid=pid, birth=str(times[0].number()), executable=name.value,
                    name=Path(name.value).name, canStop=allowed, systemCritical=bool(critical.value),
                    reason=None if allowed else 'Close this application manually; cleanup cannot stop this process.')

    @contextmanager
    def service_handle(self, name, stop=False):
        manager = self.security.OpenSCManagerW(None, None, 1)
        if not manager:
            raise c.WinError(c.get_last_error())
        service = None
        try:
            service = self.security.OpenServiceW(manager, name, 4 | (0x20 if stop else 0))
            if not service:
                raise c.WinError(c.get_last_error())
            yield service
        finally:
            if service:
                self.security.CloseServiceHandle(service)
            self.security.CloseServiceHandle(manager)

    def service_status(self, handle):
        status, needed = SERVICE_STATUS_PROCESS(), c.c_uint32()
        if not self.security.QueryServiceStatusEx(handle, 0, c.byref(status), c.sizeof(status), c.byref(needed)):
            raise c.WinError(c.get_last_error())
        return status

    def service_identity(self, name, identity):
        # A normal desktop token may be denied *all* process query access to
        # this LocalSystem service. RM still identifies the guard's owner and
        # creation time. Permit an administrator verification request, never
        # an unverified stop; the elevated helper rescans the guard and checks
        # the actual image, critical status, SCM PID and birth before control.
        pending = identity.get('inspectionDenied') is True and not identity.get('executable')
        if name != CODEX_SERVICE or identity.get('systemCritical') is True:
            return None
        if not pending and (identity.get('systemCritical', True) or not codex_service_image(identity['executable'])):
            return None
        with self.service_handle(name) as handle:
            status = self.service_status(handle)
        if status.pid != identity['pid'] or status.kind & 0x30 != 0x10 or status.flags & 1 or status.state != 4 or not status.controls & 1:
            return None
        if pending:
            return dict(identity, name='Codex sandbox service', service=name, canStop=True, canForce=False, needsElevation=True,
                        verificationPending=True,
                        reason='Windows will request administrator approval to verify and stop this Codex sandbox service. This service cannot be force stopped.')
        try:
            with self.service_handle(name, stop=True):
                pass  # Read-only access check; no service control is sent.
            elevated = False
        except OSError as error:
            if getattr(error, 'winerror', None) != 5:
                raise
            elevated = True
        return dict(identity, name='Codex sandbox service', service=name, canStop=True, canForce=False, needsElevation=elevated,
                    reason=('Windows will request administrator approval to stop this Codex sandbox service.' if elevated
                    else 'The Codex sandbox service will be stopped gracefully. Its installation is kept.') + ' This service cannot be force stopped.')

    def stop_service(self, process, allow_elevation=True):
        # Even with an administrator token, this entry point can only stop the
        # reviewed, non-critical Codex sandbox service, never delete a service.
        try:
            current = self.identity(process['pid'])
        except OSError as error:
            if not allow_elevation or getattr(error, 'winerror', None) != 5:
                raise
            current = dict(pid=process['pid'], birth=process['birth'], executable='', inspectionDenied=True)
        if not current or current['birth'] != process['birth']:
            return
        current = self.service_identity(process['service'], current)
        if not current:
            raise ValueError('The Codex sandbox service changed. Check the applications again.')
        if current['needsElevation']:
            if allow_elevation:
                return self.elevate_service(process)
            raise ValueError('Windows administrator approval is required to stop the Codex sandbox service.')
        with self.service_handle(current['service'], stop=True) as service:
            # Bind the control to this still-running service instance.
            status = self.service_status(service)
            if status.pid != current['pid'] or process_start(current['pid']) != current['birth']:
                raise ValueError('The Codex sandbox service restarted. Review its new process before stopping it.')
            result = SERVICE_STATUS()
            if not self.security.ControlService(service, 1, c.byref(result)):
                raise c.WinError(c.get_last_error())
            deadline = time.monotonic() + 15
            while self.service_status(service).state != 1 and time.monotonic() < deadline:
                time.sleep(0.1)

    def elevate_service(self, process):
        # No shell or temporary request file. The elevated helper independently
        # checks the guard-file owner, Store image, SCM PID and process birth.
        request = {key: process[key] for key in ('pid', 'birth', 'service', 'paths')}
        return self.elevate_job('stop-service', request)

    def elevate_job(self, action, request):
        if action not in ('stop-service', 'repair-access'):
            raise ValueError('Unknown administrator cleanup job.')
        payload = base64.urlsafe_b64encode(json.dumps(request).encode()).decode()
        if len(payload) > 24_000:
            raise ValueError('Too many reviewed files. Select fewer components and retry cleanup.')
        shell = c.WinDLL('shell32', use_last_error=True)
        self.bind(shell, 'ShellExecuteExW', [c.POINTER(SHELL_EXECUTE_INFO)], c.c_int)
        options = SHELL_EXECUTE_INFO()
        options.size, options.mask = c.sizeof(options), 0x40 | 0x100
        options.verb, options.file = 'runas', sys.executable
        options.parameters = subprocess.list2cmdline(['-I', '-B', str(Path(__file__).absolute()), action, payload])
        options.directory, options.show = str(Path(__file__).parent), 0
        if not shell.ShellExecuteExW(c.byref(options)):
            error = c.get_last_error()
            if error == 1223:
                raise ValueError('Windows administrator approval was cancelled. Nothing was removed.')
            raise c.WinError(error)
        try:
            if self.kernel.WaitForSingleObject(options.process, 180_000) != 0:
                raise ValueError('The administrator cleanup job did not finish. Check again.')
            code = c.c_uint32()
            if not self.kernel.GetExitCodeProcess(options.process, c.byref(code)):
                raise c.WinError(c.get_last_error())
            if code.value:
                reason = (c.FormatError(code.value).strip() if code.value != 1
                          else 'The reviewed cleanup job could not be completed.')
                raise ValueError(f'The administrator helper failed (Windows error {code.value}: {reason}). Check the applications and retry.')
        finally:
            self.kernel.CloseHandle(options.process)

    def resource_name(self, path):
        # Restart Manager has its own path limit even when enumeration and
        # CreateFileW accept extended names. Use the filesystem's existing 8.3
        # name where available; this is read-only and names the same file.
        path = display_path(path)
        if len(str(path)) < 240:
            return str(path)
        name = c.create_unicode_buffer(32768)
        length = self.kernel.GetShortPathNameW(str(filesystem_path(path)), name, len(name))
        if not length:
            raise c.WinError(c.get_last_error())
        short = display_path(name.value)
        if length >= len(name) or len(str(short)) >= 260:
            raise ValueError('Windows cannot identify applications using this long file name. Close applications using it and check again: ' + str(path))
        return str(short)

    @contextmanager
    def session_handle(self, files=(), processes=()):
        files = [self.resource_name(path) for path in files]
        session, key = c.c_uint32(), c.create_unicode_buffer(33)
        error = self.rm.RmStartSession(c.byref(session), 0, key)
        if error:
            raise c.WinError(error)
        try:
            names = (c.c_wchar_p * len(files))(*map(str, files)) if files else None
            identities = (UNIQUE_PROCESS * len(processes))(*[
                UNIQUE_PROCESS(value['pid'], FILETIME(int(value['birth']) & 0xffffffff, int(value['birth']) >> 32))
                for value in processes]) if processes else None
            error = self.rm.RmRegisterResources(session, len(files), names, len(processes), identities, 0, None)
            if error:
                raise c.WinError(error)
            yield session
        finally:
            self.rm.RmEndSession(session)

    def users(self, files):
        if not files:
            return []
        with self.session_handle(files=files) as session:
            for _ in range(4):
                needed, count, reboot = c.c_uint32(), c.c_uint32(), c.c_uint32()
                error = self.rm.RmGetList(session, c.byref(needed), c.byref(count), None, c.byref(reboot))
                if error == 0:
                    return []
                if error != 234:
                    raise c.WinError(error)
                buffer = (PROCESS_INFO * needed.value)()
                count.value = needed.value
                error = self.rm.RmGetList(session, c.byref(needed), c.byref(count), buffer, c.byref(reboot))
                if error == 0:
                    return list(buffer[:count.value])
                if error != 234:
                    raise c.WinError(error)
            raise ValueError('Applications changed while checking selected files. Retry the check.')

    def delete_access(self, path):
        # Request DELETE access, but never set delete disposition or write data.
        handle = self.kernel.CreateFileW(str(filesystem_path(path)), 0x10000, 7, None, 3, 0x02200000, None)
        if handle == c.c_void_p(-1).value:
            return c.get_last_error()
        self.kernel.CloseHandle(handle)
        return 0

    @contextmanager
    def pin_permission_file(self, item):
        """Hold every ancestor and reject reparse points and hard-linked files."""
        path = Path(item['path'])
        handles = []
        self.bind(self.kernel, 'GetFileInformationByHandle', [c.c_void_p, c.c_void_p], c.c_int)
        try:
            for index in range(len(path.parts)):
                current = Path(*path.parts[:index + 1])
                if index and (':' in path.parts[index] or path.parts[index].rstrip(' .') != path.parts[index]):
                    raise ValueError('Invalid permission repair path.')
                access = 0xE0080 if index == len(path.parts) - 1 else 0x80
                handle = self.kernel.CreateFileW(str(filesystem_path(current)), access, 3, None, 3, 0x02200000, None)
                if handle == c.c_void_p(-1).value:
                    raise c.WinError(c.get_last_error())
                handles.append(handle)
                info = c.create_string_buffer(52)
                if not self.kernel.GetFileInformationByHandle(handle, info):
                    raise c.WinError(c.get_last_error())
                attributes = c.cast(info, c.POINTER(c.c_uint32))[0]
                if attributes & 0x400 or index < len(path.parts) - 1 and not attributes & 0x10:
                    raise ValueError('Permission repair cannot traverse a linked or replaced directory.')
                if not attributes & 0x10 and c.cast(info, c.POINTER(c.c_uint32))[10] != 1:
                    raise ValueError('Permission repair cannot change a hard-linked file.')
            if file_identity(path) != item['identity']:
                raise ValueError('A reviewed file changed. Check the selected files again.')
            yield handles[-1]
        finally:
            for handle in reversed(handles):
                self.kernel.CloseHandle(handle)

    def grant_file_access(self, handle, account, *, shared=False):
        descriptor, owner, acl = c.c_void_p(), c.c_void_p(), c.c_void_p()
        present, defaulted = c.c_int(), c.c_int()
        self.bind(self.security, 'ConvertStringSecurityDescriptorToSecurityDescriptorW',
                  [c.c_wchar_p, c.c_uint32, c.POINTER(c.c_void_p), c.c_void_p], c.c_int)
        self.bind(self.security, 'GetSecurityDescriptorOwner',
                  [c.c_void_p, c.POINTER(c.c_void_p), c.POINTER(c.c_int)], c.c_int)
        self.bind(self.security, 'GetSecurityDescriptorDacl',
                  [c.c_void_p, c.POINTER(c.c_int), c.POINTER(c.c_void_p), c.POINTER(c.c_int)], c.c_int)
        self.bind(self.security, 'SetSecurityInfo',
                  [c.c_void_p, c.c_int, c.c_uint32, *([c.c_void_p] * 4)], c.c_uint32)
        self.bind(self.kernel, 'LocalFree', [c.c_void_p], c.c_void_p)
        # No inheritable ACEs: do not change an unreviewed descendant's ACL.
        sddl = f'O:{account}D:P(A;;FA;;;{account})' + ('(A;;FA;;;SY)(A;;FA;;;BA)' if shared else '')
        if not self.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None):
            raise c.WinError(c.get_last_error())
        try:
            if not self.security.GetSecurityDescriptorOwner(descriptor, c.byref(owner), c.byref(defaulted)):
                raise c.WinError(c.get_last_error())
            if not self.security.GetSecurityDescriptorDacl(descriptor, c.byref(present), c.byref(acl), c.byref(defaulted)) or not present.value or not acl.value:
                raise ValueError('The private file access rules could not be prepared.')
            error = self.security.SetSecurityInfo(handle, 1, 0x80000005, owner, None, acl, None)
            if error:
                raise c.WinError(error)
        finally:
            self.kernel.LocalFree(descriptor)

    def request_account(self, parent):
        self.bind(self.security, 'ConvertSidToStringSidW', [c.c_void_p, c.POINTER(c.c_wchar_p)], c.c_int)
        self.bind(self.kernel, 'LocalFree', [c.c_void_p], c.c_void_p)
        with self.token_privilege('SeDebugPrivilege'), self.handle(parent['pid']) as handle:
            identity = self.identity(parent['pid'], handle)
            if not identity or identity['birth'] != parent['birth']:
                raise ValueError('The requesting cleanup job has exited or changed.')
            user = c.create_string_buffer(self.user_of(handle))
            value = c.c_wchar_p()
            if not self.security.ConvertSidToStringSidW(user, c.byref(value)):
                raise c.WinError(c.get_last_error())
            try:
                return value.value
            finally:
                self.kernel.LocalFree(value)

    def scan(self, targets):
        blockers, errors = {}, []
        deadline = time.monotonic() + 90
        def record(entry, target, path):
            key = (entry.process.pid, str(entry.process.start.number()))
            if key not in blockers:
                try:
                    identity = self.identity(entry.process.pid)
                    if not identity or identity['birth'] != key[1]:
                        return
                except OSError as error:
                    identity = dict(pid=key[0], birth=key[1], name=entry.name or 'Application', executable='',
                                    inspectionDenied=getattr(error, 'winerror', None) == 5,
                                    canStop=False, reason='Windows could not verify this process. Close it manually.')
                service = self.service_identity(entry.service, identity) if entry.kind == 3 else None
                if service:
                    identity = service
                elif entry.kind in (3, 4, 1000):  # service, Explorer, critical
                    identity.update(canStop=False, reason='Close this application or service manually before cleanup.')
                identity.update(paths=[], components=[])
                blockers[key] = identity
            add_evidence(blockers[key], target['component'], str(path))

        for target in targets:
            candidates, images = [], []
            try:
                for path, info in regular_files(target['path'], deadline, include_directories=True):
                    error = self.delete_access(path)
                    if stat.S_ISDIR(info.st_mode):
                        if error:
                            errors.append(dict(path=str(path), winerror=error,
                                message='Administrator approval is needed to restore access to this selected directory.' if error == 5
                                else 'This directory could not be checked. Close applications using it and retry.'))
                        continue
                    image = path.suffix.lower() in ('.exe', '.dll', '.pyd')
                    if image:
                        images.append(path)
                    if error in (32, 33) or error == 5 and (
                            not getattr(info, 'st_file_attributes', 0) & 1 or image):
                        candidates.append((path, error))
                if len(candidates) > 1024:
                    raise ValueError('Too many selected files are unavailable. Select fewer components and retry.')
                # Per-file attribution makes the guard file visible in the UI.
                for path, error in candidates:
                    try:
                        users = self.users([path])
                    except OSError as query_error:
                        # One inaccessible file must not hide the owners of
                        # other selected files behind a directory-level error.
                        errors.append(dict(path=str(path), message=str(query_error), winerror=getattr(query_error, 'winerror', None)))
                        continue
                    if not users:
                        if error in (32, 33) or not filesystem_path(path).exists():
                            # A short-lived lock may have vanished during lookup.
                            if filesystem_path(path).exists() and self.delete_access(path) in (32, 33):
                                errors.append(dict(path=str(path), message='A file is in use, but Windows did not identify its owner. Close applications using it and retry.'))
                        elif not getattr(filesystem_path(path).lstat(), 'st_file_attributes', 0) & 1:
                            errors.append(dict(path=str(path), message='Administrator approval is needed to restore access to this selected file.', winerror=5))
                    for entry in users:
                        record(entry, target, path)
                # A loaded image can allow opening a DELETE handle while its
                # image section still prevents removal. Check these in batches.
                for offset in range(0, len(images), 256):
                    if time.monotonic() > deadline:
                        raise ValueError('Checking selected files took too long. Select fewer components and retry.')
                    for entry in self.users(images[offset:offset + 256]):
                        record(entry, target, target['path'])
            except (OSError, ValueError) as error:
                failed = display_path(error.filename) if getattr(error, 'filename', None) else Path(target['path'])
                root = Path(target['path'])
                if not failed.is_absolute() or not (failed == root or failed.is_relative_to(root)):
                    failed = root
                errors.append(dict(path=str(failed), message=str(error), winerror=getattr(error, 'winerror', None)))
        return dict(blockers=list(blockers.values()), errors=errors)

    def stop(self, processes, force):
        errors = []
        for process in processes:
            try:
                if process.get('service'):
                    if not force:  # Services are never terminated by force.
                        self.stop_service(process)
                    continue
                # Hold the same kernel process object through verification and
                # termination, so a recycled PID can never receive the signal.
                with self.handle(process['pid'], terminate=force) as handle:
                    current = self.identity(process['pid'], handle)
                    if not current or current['birth'] != process['birth']:
                        continue
                    if not current['canStop']:
                        raise ValueError(current['reason'])
                    if force:
                        if not self.kernel.TerminateProcess(handle, 1):
                            raise c.WinError(c.get_last_error())
                        self.kernel.WaitForSingleObject(handle, 5000)
                    else:
                        # Register only approved PID+birth identities, never the
                        # resource paths (which might acquire new users now).
                        with self.session_handle(processes=[current]) as session:
                            error = self.rm.RmShutdown(session, 0, None)
                            if error not in (0, 351):
                                raise c.WinError(error)
            except (OSError, ValueError) as error:
                if process.get('service') == CODEX_SERVICE or process_start(process['pid']) == process['birth']:
                    errors.append(dict(pid=process['pid'], message=str(error)))
        return errors


def add_evidence(process, component, path):
    if component not in process['components']:
        process['components'].append(component)
    if path not in process['paths'] and len(process['paths']) < 8:
        process['paths'].append(path)


class Posix:
    def __init__(self, protected):
        self.protected = set(protected) | {os.getpid(), os.getppid(), 0, 1}

    def identity(self, pid):
        birth = process_start(pid)
        if not birth:
            return None
        if sys.platform == 'linux':
            directory = Path('/proc') / str(pid)
            if directory.stat().st_uid != os.getuid():
                return None
            try:
                executable = os.readlink(directory / 'exe').removesuffix(' (deleted)')
            except OSError:
                executable = ''
            name = (directory / 'comm').read_text().strip()
        else:
            output = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'uid=,comm='],
                                    capture_output=True, text=True, timeout=5, check=True).stdout.strip().split(None, 1)
            if not output or int(output[0]) != os.getuid():
                return None
            executable = output[1] if len(output) > 1 else ''
            name = Path(executable).name or 'Application'
        return dict(pid=pid, birth=birth, name=name, executable=executable,
                    canStop=pid not in self.protected, reason=None if pid not in self.protected else 'Cleanup cannot stop its own process.',
                    paths=[], components=[])

    def scan(self, targets):
        if sys.platform == 'linux':
            return self.scan_linux(targets)
        # lsof is included with macOS. NUL fields avoid ambiguous filenames.
        result = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-u', str(os.getuid()), '-F0pn'],
                                capture_output=True, timeout=30)
        if result.returncode not in (0, 1):
            return dict(blockers=[], errors=[dict(path='', message='Could not inspect open files. Close applications using selected components and retry.')])
        blockers, pid = {}, None
        for field in result.stdout.split(b'\0'):
            field = field.lstrip(b'\n')
            if field.startswith(b'p'):
                pid = int(field[1:])
            elif field.startswith(b'n') and pid:
                path = os.fsdecode(field[1:])
                self.record(blockers, pid, path, targets)
        return dict(blockers=list(blockers.values()), errors=[])

    def record(self, blockers, pid, path, targets):
        if not path.startswith('/'):
            return
        matches = [target for target in targets if Path(path).is_relative_to(Path(target['path']))]
        if not matches:
            return
        if pid not in blockers:
            identity = self.identity(pid)
            if not identity:
                return
            blockers[pid] = identity
        for target in matches:
            add_evidence(blockers[pid], target['component'], path)

    def scan_linux(self, targets):
        blockers = {}
        for directory in Path('/proc').iterdir():
            if not directory.name.isdigit():
                continue
            try:
                if directory.stat().st_uid != os.getuid():
                    continue
                pid = int(directory.name)
                paths = [directory / 'exe', directory / 'cwd', *list((directory / 'fd').iterdir())]
                for path in paths:
                    try:
                        self.record(blockers, pid, os.readlink(path).removesuffix(' (deleted)'), targets)
                    except FileNotFoundError:
                        pass
                # Shared libraries can stay mapped after their descriptor closes.
                for line in (directory / 'maps').read_text().splitlines():
                    parts = line.split(None, 5)
                    if len(parts) == 6:
                        self.record(blockers, pid, parts[5].removesuffix(' (deleted)'), targets)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        return dict(blockers=list(blockers.values()), errors=[])

    def stop(self, processes, force):
        errors = []
        for process in processes:
            descriptor = None
            try:
                if sys.platform == 'linux' and hasattr(os, 'pidfd_open'):
                    descriptor = os.pidfd_open(process['pid'])
                current = self.identity(process['pid'])
                if not current or current['birth'] != process['birth']:
                    continue
                if not current['canStop']:
                    raise ValueError(current['reason'])
                number = signal.SIGKILL if force else signal.SIGTERM
                if descriptor is not None:
                    signal.pidfd_send_signal(descriptor, number)
                else:
                    os.kill(process['pid'], number)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                errors.append(dict(pid=process['pid'], message=str(error)))
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        return errors


def check(targets, *, protected=(), reviewed=None, force=False, backend=None):
    targets = normalize_targets(targets)
    backend = backend or (Windows(protected) if os.name == 'nt' else Posix(protected))
    report = backend.scan(targets)
    if reviewed is None:
        return report
    if not isinstance(reviewed, list) or not reviewed or any(
            not isinstance(value, dict) or type(value.get('pid')) is not int or
            not isinstance(value.get('birth'), str) for value in reviewed):
        raise ValueError('Review the blocking applications before stopping them.')
    approved = {(value['pid'], value['birth']) for value in reviewed}
    current = {(value['pid'], value['birth']) for value in report['blockers']}
    # New users must be displayed before any stop action. Exited users are fine.
    if report['errors'] or not current <= approved:
        return dict(report, changed=True)
    stop = [value for value in report['blockers'] if value['canStop'] and (value['pid'], value['birth']) in approved]
    errors = backend.stop(stop, force) if stop else []
    deadline = time.monotonic() + 5
    while any(process_start(value['pid']) == value['birth'] for value in stop) and time.monotonic() < deadline:
        time.sleep(0.1)
    return dict(backend.scan(targets), stopErrors=errors, attempted=True)


def profile_directory(account):
    import winreg
    if not isinstance(account, str) or not re.fullmatch(r'S-1-(?:5-21|12-1)(?:-\d+){4}', account):
        raise ValueError('A registered Windows user account is required.')
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                        r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' + chr(92) + account) as key:
        value, _ = winreg.QueryValueEx(key, 'ProfileImagePath')
    return Path(os.path.expandvars(value)).absolute()


def elevated_permission_repair(request, backend=None):
    """Restore access to a bounded, reviewed job; never remove files or stop agents."""
    if (not isinstance(request, dict) or request.get('schema') != 1 or
            not isinstance(request.get('base'), str) or not isinstance(request.get('parent'), dict) or
            type(request['parent'].get('pid')) is not int or not 0 < request['parent']['pid'] <= 0xffffffff or not isinstance(request['parent'].get('birth'), str) or
            not isinstance(request.get('targets'), list) or not 1 <= len(request['targets']) <= 256 or
            not isinstance(request.get('files'), list) or not 1 <= len(request['files']) <= 128):
        raise ValueError('Invalid reviewed permission repair job.')
    backend = backend or Windows(())
    if backend.request_account(request['parent']) != request.get('account'):
        raise ValueError('The cleanup account changed. Review the checklist again.')
    profile, base = profile_directory(request['account']), Path(request['base'])
    targets = request['targets']
    if any(not isinstance(target, dict) or not isinstance(target.get('path'), str) or
           not isinstance(target.get('component'), str) or not permission_scope(profile, base, target) for target in targets):
        raise ValueError('Permission repair is outside the selected provider data.')
    seen = set()
    for item in request['files']:
        if (not isinstance(item, dict) or not isinstance(item.get('path'), str) or
                not isinstance(item.get('identity'), dict) or not isinstance(item.get('component'), str)):
            raise ValueError('Invalid reviewed file identity.')
        path = Path(item['path'])
        if str(path) in seen or not permission_scope(profile, base, item) or not any(
                item['component'] == target['component'] and
                (path == Path(target['path']) or path.is_relative_to(Path(target['path']))) for target in targets):
            raise ValueError('The reviewed file is outside the selected component.')
        seen.add(str(path))
    with backend.token_privilege('SeBackupPrivilege'), backend.token_privilege('SeRestorePrivilege'), ExitStack() as stack:
        # Pin and revalidate the entire job before changing its first ACL.
        handles = [stack.enter_context(backend.pin_permission_file(item)) for item in request['files']]
        for handle, item in zip(handles, request['files']):
            backend.grant_file_access(handle, request['account'], shared=item['component'].startswith('native:'))


def repair_permissions(report, targets, base, reviewed, backend=None):
    if os.name != 'nt' or not isinstance(reviewed, list) or not reviewed:
        raise ValueError('Review the files requiring administrator access first.')
    current = report.get('permissionReview', [])
    if any(item not in reviewed for item in current):
        return dict(report, changed=True)
    if not current:
        return report
    from aixand_filesystem import current_user_sid as sid
    account = sid()
    profile = profile_directory(account)
    selected = [target for target in targets if permission_scope(profile, Path(base), target) and any(
        item['component'] == target['component'] and
        (Path(item['path']) == Path(target['path']) or Path(item['path']).is_relative_to(Path(target['path']))) for item in current)]
    request = dict(schema=1, account=account, base=str(base), targets=selected, files=current,
                   parent=dict(pid=os.getpid(), birth=process_start(os.getpid())))
    backend = backend or Windows(())
    backend.elevate_job('repair-access', request)
    return permission_review(dict(backend.scan(targets), permissionsRepaired=True), targets, Path(base), profile)


def elevated_service_stop(request, backend=None):
    """Privileged operation: stop one revalidated Codex service; no deletions."""
    if (not isinstance(request, dict) or request.get('service') != CODEX_SERVICE or
            type(request.get('pid')) is not int or request['pid'] <= 0 or
            not isinstance(request.get('birth'), str) or not isinstance(request.get('paths'), list) or
            not 1 <= len(request['paths']) <= 8):
        raise ValueError('Invalid reviewed Codex service.')
    targets = []
    for value in request['paths']:
        if not isinstance(value, str):
            raise ValueError('Invalid Codex service resource.')
        path = Path(value)
        if (not path.is_absolute() or path.parent.name != '.codex' or
                not path.name.startswith('.codex-provisioning-') or not path.name.endswith('.guard') or
                os.name == 'nt' and (len(path.drive) != 2 or not path.drive.endswith(':'))):
            continue
        targets.append(dict(component='native:codex', path=str(path)))
    if not targets:
        raise ValueError('No reviewed native Codex guard file.')
    backend = backend or Windows(())
    targets = normalize_targets(targets)
    with backend.service_inspection_privilege():
        report = backend.scan(targets)
        if report['errors']:
            raise ValueError('The Codex service resources could not be checked.')
        for process in report['blockers']:
            if process.get('service') != CODEX_SERVICE:
                continue
            if process['pid'] != request['pid'] or process['birth'] != request['birth']:
                raise ValueError('The Codex service restarted. Review its new process.')
            backend.stop_service(process, allow_elevation=False)
            return
    # The reviewed guard is already free. Do not stop an unrelated/new process.


if __name__ == '__main__':
    try:
        if os.name != 'nt' or len(sys.argv) != 3 or sys.argv[1] not in ('stop-service', 'repair-access') or len(sys.argv[2]) > 24_000:
            raise ValueError('Invalid administrator cleanup command.')
        action = elevated_service_stop if sys.argv[1] == 'stop-service' else elevated_permission_repair
        action(json.loads(base64.urlsafe_b64decode(sys.argv[2]).decode()))
    except Exception as error:
        # Preserve Windows failures across the UAC process boundary instead
        # of hiding access denied (and every other failure) behind exit 1.
        code = getattr(error, 'winerror', None)
        sys.exit(code if type(code) is int and 1 <= code <= 65535 else 1)
