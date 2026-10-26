#!/usr/bin/env python3
"""Exercise the real NSIS maintenance page against disposable Windows fixtures.

Requires Tauri's cached NSIS tools. Never reads or changes a real installation.
The tiny fixture uninstaller records its arguments instead of cleaning user data.
"""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def main():
    if os.name != 'nt':
        raise SystemExit('Run this verification on Windows.')
    import winreg

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nsis', type=Path,
        default=Path(os.environ['LOCALAPPDATA']) / 'tauri/NSIS')
    parser.add_argument('--languages', type=Path, required=True,
        help='Directory containing the generated Tauri English.nsh')
    parser.add_argument('--template', type=Path,
        default=Path(__file__).resolve().parents[1] / 'aixand-web/src-tauri/windows/installer.nsi')
    parser.add_argument('--runtime', type=Path, required=True,
        help='Qualified previous runtime with the old cleanup helper and managed Python')
    parser.add_argument('--native', type=Path, required=True,
        help='Qualified distributed NSIS desktop executable; never executed by fixtures')
    parser.add_argument('--helper', type=Path,
        default=Path(__file__).resolve().parent / 'runtime/cleanup_processes.py')
    parser.add_argument('--previous-helper', type=Path,
        help='Also exercise removal from the compatible previous cleanup repair')
    parser.add_argument('--provider-helper', type=Path,
        default=Path(__file__).resolve().parent / 'runtime/provider-cleanup.py')
    parser.add_argument('--edition', choices=('distributed', 'standalone'), default='distributed')
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('maintenance', args.template.parent / 'maintenance-update.py')
    maintenance = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(maintenance)
    helper = args.helper.read_bytes()
    provider_helper = args.provider_helper.read_bytes()
    maintenance.verified_payload(args.helper, args.provider_helper)
    old_helper = (args.runtime / 'cleanup_processes.py').read_bytes()
    assert hashlib.sha256(old_helper).hexdigest() in maintenance.COMPATIBLE_HELPER_SHA256 | {maintenance.HELPER_SHA256}
    assert hashlib.sha256(args.native.read_bytes()).hexdigest() in (
        {maintenance.DESKTOP_SHA256[args.edition]} | maintenance.COMPATIBLE_DESKTOP_SHA256.get(args.edition, set()))
    template = args.template.read_text(encoding='utf-8-sig')
    # Compile the production page, selection handler and leave handler verbatim.
    page = template.split('Var ReinstallPageCheck\n', 1)[1].split('; 5. Choose install directory page', 1)[0]
    page = 'Var ReinstallPageCheck\n' + page
    user = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.IsWindowEnabled.argtypes = [wintypes.HWND]
    user.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user.SendMessageW.restype = ctypes.c_ssize_t
    user.PostMessageW.argtypes = user.SendMessageW.argtypes
    user.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
    user.GetDlgItem.restype = wintypes.HWND
    user.GetDlgCtrlID.argtypes = [wintypes.HWND]
    user.GetDlgCtrlID.restype = ctypes.c_int

    def label(hwnd):
        buf = ctypes.create_unicode_buffer(2048)
        user.GetWindowTextW(hwnd, buf, len(buf))
        return buf.value.replace('&', '')

    def windows(pid):
        found = []
        @callback_type
        def visit(hwnd, _):
            owner = wintypes.DWORD()
            user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid and user.IsWindowVisible(hwnd):
                found.append(hwnd)
            return True
        user.EnumWindows(visit, 0)
        return found

    def children(hwnd):
        found = []
        @callback_type
        def visit(child, _):
            if user.IsWindowVisible(child):
                found.append((child, label(child)))
            return True
        user.EnumChildWindows(hwnd, visit, 0)
        return found

    def wait(predicate, process, description):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            if process.poll() is not None:
                raise AssertionError(f'{description}: setup exited with {process.returncode}')
            time.sleep(.05)
        raise AssertionError(f'Timed out: {description}; UI: {[children(w) for w in windows(process.pid)]}')

    def radio_window(process):
        def find():
            for hwnd in windows(process.pid):
                controls = children(hwnd)
                if any('Uninstall Aixand' in text or 'Uninstall before' in text for _, text in controls):
                    return hwnd
        return wait(find, process, 'maintenance page')

    def click(hwnd):
        # Post the click: Next can synchronously wait for its child uninstaller.
        user.PostMessageW(hwnd, 0x00F5, 0, 0)  # BM_CLICK

    results = []
    with tempfile.TemporaryDirectory(prefix='aixand-maintenance-') as temporary:
        root = Path(temporary)
        product = 'Aixand Maintenance Fixture ' + uuid.uuid4().hex
        uninstall_key = r'Software\Microsoft\Windows\CurrentVersion\Uninstall' + '\\' + product
        product_key = r'Software\AixandMaintenanceFixtures' + '\\' + product
        common = rf'''
Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include StrFunc.nsh
${{StrCase}}
${{StrLoc}}
!addplugindir "{args.nsis / 'Plugins/x86-unicode/additional'}"
!define PRODUCTNAME "{product}"
!define MANUFACTURER "AixandMaintenanceFixtures"
!define VERSION "0.1.0-beta"
!define ALLOWDOWNGRADES "true"
!define MAINBINARYNAME "aixand-desktop"
!define UNINSTKEY "{uninstall_key}"
!define MANUPRODUCTKEY "{product_key}"
Name "${{PRODUCTNAME}}"
InstallDir "{root / 'installation'}"
'''
        bootstrap = common + rf'''
OutFile "{root / 'bootstrap.exe'}"
SilentInstall silent
SilentUnInstall silent
Section
  SetShellVarContext current
  CreateDirectory "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${{UNINSTKEY}}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${{UNINSTKEY}}" "DisplayVersion" "${{VERSION}}"
  WriteRegStr HKCU "${{MANUPRODUCTKEY}}" "" "$INSTDIR"
SectionEnd
Section Uninstall
  CopyFiles /SILENT "$INSTDIR\runtime\cleanup_processes.py" "$INSTDIR\helper-at-uninstall.py"
  CopyFiles /SILENT "$INSTDIR\runtime\provider-cleanup.py" "$INSTDIR\provider-at-uninstall.py"
  FileOpen $0 "$INSTDIR\uninstall-args.txt" w
  FileWrite $0 "$CMDLINE"
  FileClose $0
  FileOpen $0 "$INSTDIR\outcome.txt" r
  FileRead $0 $1
  FileClose $0
  ${{If}} $1 == "cancel"
    SetErrorLevel 1
    Quit
  ${{ElseIf}} $1 == "failure"
    SetErrorLevel 5
    Quit
  ${{EndIf}}
  Delete "$INSTDIR\aixand-desktop.exe"
  DeleteRegKey HKCU "${{UNINSTKEY}}"
  DeleteRegKey HKCU "${{MANUPRODUCTKEY}}"
  SetErrorLevel 0
SectionEnd
'''
        setup = common + rf'''
OutFile "{root / 'setup.exe'}"
Var PassiveMode
Var UpdateMode
Var WixMode
!define AIXAND_MAINTENANCE_HELPER "{args.helper}"
!define AIXAND_MAINTENANCE_PROVIDER "{args.provider_helper}"
!include "{args.template.parent / 'runtime-hooks.nsh'}"
{page}
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryReached
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!include "{args.languages / 'English.nsh'}"
Function .onInit
  SetShellVarContext current
  ${{GetOptions}} $CMDLINE "/UPDATE" $UpdateMode
  ${{IfNot}} ${{Errors}}
    StrCpy $UpdateMode 1
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/P" $PassiveMode
  ${{IfNot}} ${{Errors}}
    StrCpy $PassiveMode 1
  ${{EndIf}}
FunctionEnd
Function DirectoryReached
  ${{IfThen}} $PassiveMode = 1 ${{|}} Abort ${{|}}
  FileOpen $0 "$INSTDIR\directory-reached.txt" w
  FileWrite $0 "directory"
  FileClose $0
FunctionEnd
Section
  FileOpen $0 "$INSTDIR\install-reached.txt" w
  FileWrite $0 "fixture only: no application installed"
  FileClose $0
  SetAutoClose true
SectionEnd
'''
        # Windows paths above are NSIS source strings, never shell commands.
        for name, code in (('bootstrap', bootstrap), ('setup', setup)):
            nsi = root / (name + '.nsi')
            nsi.write_text(code, encoding='utf-8-sig')
            compiled = subprocess.run([str(args.nsis / 'makensis.exe'), '/V2', str(nsi)],
                capture_output=True, text=True, timeout=30)
            if compiled.returncode:
                raise RuntimeError(compiled.stdout + compiled.stderr)

        cases = [
            ('reinstall', [], '0.1.0-beta', 1, 'success', 'directory', False),
            ('update-reinstall', ['/UPDATE'], '0.1.0-beta', 1, 'success', 'directory', False),
            ('remove', [], '0.1.0-beta', 2, 'success', 'removed', True),
            ('update-remove', ['/UPDATE'], '0.1.0-beta', 2, 'success', 'removed', True),
            ('cancel-remove', [], '0.1.0-beta', 2, 'cancel', 'cancelled', True),
            ('cancel-update-remove', ['/UPDATE'], '0.1.0-beta', 2, 'cancel', 'cancelled', True),
            ('failed-update-remove', ['/UPDATE'], '0.1.0-beta', 2, 'failure', 'failed', True),
            ('upgrade-replace', [], '0.0.9-beta', 1, 'success', 'directory', True),
            ('update-upgrade-replace', ['/UPDATE'], '0.0.9-beta', 1, 'success', 'directory', True),
            ('update-upgrade-in-place', ['/UPDATE'], '0.0.9-beta', 2, 'success', 'directory', False),
            ('downgrade-replace', [], '0.2.0-beta', 1, 'success', 'directory', True),
            ('update-downgrade-in-place', ['/UPDATE'], '0.2.0-beta', 2, 'success', 'directory', False),
            ('passive-reinstall', ['/P'], '0.1.0-beta', 1, 'success', 'installed', False),
            ('passive-update', ['/P', '/UPDATE'], '0.0.9-beta', 1, 'success', 'installed', False),
            ('silent-update', ['/S', '/UPDATE'], '0.0.9-beta', 1, 'success', 'installed', False),
            ('unverified-cleanup', [], '0.1.0-beta', 2, 'prepare-failure', 'prepare-failed', False),
            ('update-unverified-cleanup', ['/UPDATE'], '0.1.0-beta', 2, 'prepare-failure', 'prepare-failed', False),
            ('current-cleanup-remove', [], '0.1.0-beta', 2, 'current', 'removed', True),
            ('update-current-cleanup-remove', ['/UPDATE'], '0.1.0-beta', 2, 'current', 'removed', True),
            ('mixed-cleanup-remove', [], '0.1.0-beta', 2, 'mixed', 'removed', True),
        ]
        if args.previous_helper:
            previous_helper = args.previous_helper.read_bytes()
            assert hashlib.sha256(previous_helper).hexdigest() == '2602a393f4b05d9562be77917f52f35fd4f2d10a33d505273c1deb1992d9ea2d'
            cases += [
                ('previous-repair-remove', [], '0.1.0-beta', 2, 'previous-repair', 'removed', True),
                ('update-previous-repair-remove', ['/UPDATE'], '0.1.0-beta', 2, 'previous-repair', 'removed', True),
            ]
        installation = root / 'installation'
        runtime = installation / 'runtime'
        runtime.mkdir(parents=True)
        # Use the real managed interpreter, without copying vendor packages.
        python = runtime / 'python'
        python.mkdir()
        for path in (args.runtime / 'python').iterdir():
            if path.is_file():
                os.link(path, python / path.name)
            elif path.name in ('Lib', 'DLLs'):
                shutil.copytree(path, python / path.name, copy_function=os.link,
                    ignore=shutil.ignore_patterns('site-packages', 'test', 'tests', '__pycache__'))
        provider = (args.runtime / 'provider-cleanup.py').read_bytes()
        try:
            for name, flags, version, choice, outcome, expected, called in cases:
                installation.mkdir(exist_ok=True)
                for marker in ('directory-reached.txt', 'install-reached.txt', 'uninstall-args.txt', 'helper-at-uninstall.py', 'provider-at-uninstall.py'):
                    (installation / marker).unlink(missing_ok=True)
                shutil.copy2(args.native, installation / 'aixand-desktop.exe')
                initial_helper = b'# unverified fixture helper\n' if outcome == 'prepare-failure' else old_helper
                if outcome == 'previous-repair':
                    initial_helper = previous_helper
                if outcome in ('current', 'mixed'):
                    initial_helper = helper
                initial_provider = provider_helper if outcome == 'current' else provider
                (runtime / 'cleanup_processes.py').write_bytes(initial_helper)
                (runtime / 'provider-cleanup.py').write_bytes(initial_provider)
                inventory = ''.join(hashlib.sha256(value).hexdigest() + '  ' + filename + '\n'
                    for filename, value in (('cleanup_processes.py', initial_helper), ('provider-cleanup.py', initial_provider)))
                (runtime / 'SHA256SUMS').write_bytes(inventory.encode())
                (runtime / 'manifest.json').write_text(json.dumps(dict(platform='windows',
                    installation=dict(edition=args.edition),
                    build=hashlib.sha256((inventory + args.edition).encode()).hexdigest())), encoding='utf-8')
                (installation / 'saved-data.txt').write_text('preserve', encoding='utf-8')
                (installation / 'outcome.txt').write_text(outcome, encoding='utf-8')
                subprocess.run([str(root / 'bootstrap.exe'), '/S'], check=True, timeout=10)
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, uninstall_key, 0, winreg.KEY_SET_VALUE) as key:
                    winreg.SetValueEx(key, 'DisplayVersion', 0, winreg.REG_SZ, version)
                process = subprocess.Popen([str(root / 'setup.exe'), *flags])
                try:
                    if expected != 'installed':
                        hwnd = radio_window(process)
                        radios = [(control, text) for control, text in children(hwnd)
                            if ('add/reinstall' in text.lower() or 'add or reinstall' in text.lower()
                                or text.startswith('Uninstall ') or text.startswith('Do not uninstall'))]
                        assert len(radios) == 2, radios
                        click(radios[choice - 1][0])
                        wait(lambda: user.SendMessageW(radios[choice - 1][0], 0x00F0, 0, 0) == 1,
                            process, 'radio selection')
                        click(user.GetDlgItem(hwnd, 1))
                    if expected in ('removed', 'installed'):
                        assert process.wait(timeout=12) == 0
                    elif expected == 'directory':
                        wait(lambda: (installation / 'directory-reached.txt').exists(), process, 'install directory')
                    else:
                        if expected != 'prepare-failed':
                            wait(lambda: (installation / 'uninstall-args.txt').exists(), process, 'uninstaller called')
                        if expected in ('failed', 'prepare-failed'):
                            def dismiss_error():
                                for window in windows(process.pid):
                                    if any('Unable to uninstall' in text or 'Setup could not prepare' in text
                                           for _, text in children(window)):
                                        # A standard message box need not be the active window.
                                        button = next(control for control, text in children(window) if text == 'OK')
                                        user.PostMessageW(window, 0x0111, user.GetDlgCtrlID(button), button)
                                        return True
                            wait(dismiss_error, process, 'uninstall failure message')
                        hwnd = radio_window(process)
                        wait(lambda: user.IsWindowEnabled(hwnd), process, 'maintenance enabled after uninstall')
                        time.sleep(.15)  # Allow NSIS to recreate the custom page after Abort.
                        hwnd = radio_window(process)
                        assert not (installation / 'directory-reached.txt').exists()
                        assert (installation / 'aixand-desktop.exe').exists()
                        # A cancelled/failed removal can still be changed to reinstall.
                        first = next(control for control, text in children(hwnd)
                            if 'add/reinstall' in text.lower() or 'add or reinstall' in text.lower())
                        click(first)
                        wait(lambda: user.SendMessageW(first, 0x00F0, 0, 0) == 1,
                            process, 'reinstall selected after cancellation')
                        click(user.GetDlgItem(hwnd, 1))
                        wait(lambda: (installation / 'directory-reached.txt').exists(), process, 'reinstall after cancellation')
                    recorded = installation / 'uninstall-args.txt'
                    assert recorded.exists() == called, (name, 'unexpected uninstaller invocation')
                    if called:
                        command = recorded.read_text(encoding='utf-8-sig')
                        assert ('/UPDATE' in command) == (version != '0.1.0-beta'), (name, command)
                        # The real old uninstaller must see the refreshed helper
                        # on explicit removal, including after setup /UPDATE.
                        expected_helper = helper if version == '0.1.0-beta' else old_helper
                        assert (installation / 'helper-at-uninstall.py').read_bytes() == expected_helper
                        expected_provider = provider_helper if version == '0.1.0-beta' else initial_provider
                        assert (installation / 'provider-at-uninstall.py').read_bytes() == expected_provider
                    else:
                        assert (runtime / 'cleanup_processes.py').read_bytes() == initial_helper
                        assert (runtime / 'provider-cleanup.py').read_bytes() == initial_provider
                    if expected == 'removed':
                        assert not (installation / 'directory-reached.txt').exists()
                        assert not (installation / 'aixand-desktop.exe').exists()
                    assert (installation / 'saved-data.txt').read_text() == 'preserve'
                    results.append(dict(case=name, passed=True))
                    print(json.dumps(results[-1]), flush=True)
                finally:
                    if process.poll() is None:
                        for window in windows(process.pid):
                            user.PostMessageW(window, 0x0010, 0, 0)  # WM_CLOSE
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.terminate()  # Only our disposable setup process.
                            process.wait(timeout=3)
        finally:
            for key in (uninstall_key, product_key):
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
                except FileNotFoundError:
                    pass
    print(json.dumps(dict(passed=True, edition=args.edition, cases=results, realInstallationModified=False)))


if __name__ == '__main__':
    main()
