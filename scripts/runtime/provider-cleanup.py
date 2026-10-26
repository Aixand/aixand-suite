"""Suite-owned cleanup adapter; never change independent product releases.

Uses Agent Manager's existing ownership checks and official Claude sign-out.
Private cleanup stays in the Suite workspace. Shared provider software and
default native account directories require separate, explicit checklist choices.
"""
import json
import hashlib
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import uuid

# -I deliberately omits the script directory. Only this installed, Suite-owned
# module directory is added, never a caller-supplied Python search path.
sys.path.insert(0, str(Path(__file__).parent))
import cleanup_processes

from agent_manager.core import Manager
from agent_manager import provider_config, provider_software, claude_accounts
from agent_manager import install
from agent_manager.provider_catalog import active_profiles
from agent_manager.recovery import reconcile


def plain_path(path):
    """Check real directory ancestors without traversing Windows junctions."""
    for entry in (path, *path.parents):
        info = entry.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            return False
    return True


def junction_target(path):
    if not path.is_junction():
        raise ValueError('Expected a native Windows directory junction')
    value = os.readlink(path)
    for prefix in ('\\\\?\\', '\\??\\'):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    target = Path(value)
    if not target.is_absolute():
        raise ValueError('Expected an absolute vendor junction target')
    return target


def windows_codex_layout():
    """Recognize only Codex's two exact vendor junctions and package metadata.

    Read reparse points themselves rather than traversing them. Windows can
    reject traversal with ERROR_UNTRUSTED_MOUNT_POINT even for a vendor link.
    Neither account data nor other provider packages are software targets.
    """
    if os.name != 'nt':
        return None
    home = Path.home()
    local = Path(os.environ.get('LOCALAPPDATA', home / 'AppData/Local'))
    packages = home / '.codex/packages/standalone'
    launcher = local / 'Programs/OpenAI/Codex/bin'
    try:
        if not local.is_absolute() or not local.is_relative_to(home):
            return None
        if not plain_path(launcher.parent) or not plain_path(packages / 'releases'):
            return None
        current = packages / 'current'
        if junction_target(launcher) != current / 'bin':
            return None
        release = junction_target(current)
        if release.parent != packages / 'releases' or not plain_path(release / 'bin'):
            return None
        metadata = release / 'codex-package.json'
        executable = release / 'bin/codex.exe'
        if not plain_path(metadata) or not plain_path(executable) or metadata.stat().st_size > 4096:
            return None
        contents = metadata.read_bytes()
        package = json.loads(contents)
        if (package.get('layoutVersion') != 1 or package.get('variant') != 'codex'
                or package.get('entrypoint') != 'bin/codex.exe'
                or package.get('target') not in ('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')
                or release.name != str(package.get('version')) + '-' + package['target']
                or not stat.S_ISREG(executable.lstat().st_mode)):
            return None
        entries = [launcher, packages, current, release, metadata, executable]
        identity = []
        for path in entries:
            info = path.lstat()
            identity.append([str(path), info.st_ino, info.st_size, info.st_mtime_ns,
                             os.readlink(path) if path.is_junction() else None])
        revision = hashlib.sha256(json.dumps([identity, hashlib.sha256(contents).hexdigest()]).encode()).hexdigest()
        return dict(path=str(launcher / 'codex.exe'), targets=[str(launcher), str(packages)],
                    executable=str(executable), version=package['version'], revision=revision)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError):
        return None


def software_plan(manager):
    layout = windows_codex_layout() if getattr(manager, 'provider', None) == 'codex' else None
    if layout:
        try:
            found = install.provider_executable(manager)
        except OSError as error:
            if getattr(error, 'winerror', None) != 448:
                raise
            found = None
        configured = manager.config.get('executable', 'codex')
        native = Path(layout['path'])
        # Preserve an explicitly selected npm installation or custom CLI.
        if ((found is not None and Path(found) in (native, Path(layout['executable'])))
                or (found is None and configured in ('codex', 'codex.exe', str(native)))):
            disabled = provider_software.disabled(manager)
            current = dict(layout)
            current.update(automatic=True, bundled=False, method='installer',
                           disabled=disabled, reason=None, command=[], manualCommands=[],
                           revision='sha256:' + hashlib.sha256((layout['revision'] + str(disabled)).encode()).hexdigest(),
                           aixandWindowsCodex=True)
            return current
    return provider_software.plan(manager)


def uninstall_windows_codex(manager, reviewed):
    from agent_manager.provider_catalog import active_profiles
    with provider_software.locks(manager.lock_root, 'provider-software'), \
            provider_software.locks(install.state_root() / 'locks', 'install-codex'):
        current = software_plan(manager)
        if not current.get('aixandWindowsCodex') or current['revision'] != reviewed['revision']:
            raise ValueError('The Codex installation changed. Refresh the checklist before retrying.')
        if active_profiles(manager):
            raise ValueError('Stop Codex agents before removing their CLI.')
        moved = []
        try:
            for name in current['targets']:
                source = Path(name)
                destination = source.with_name(source.name + '.aixand-uninstall-' + uuid.uuid4().hex)
                source.rename(destination)
                moved.append((source, destination))
        except OSError:
            for source, destination in reversed(moved):
                destination.rename(source)
            raise ValueError('Codex files are in use or not writable. Close Codex processes and retry.') from None
        for _, destination in moved:
            if destination.is_junction():
                destination.rmdir()  # Remove the link itself, never its target.
            else:
                # Python 3.12 on Windows unlinks directory junctions inside a
                # tree rather than following them, including the current link.
                shutil.rmtree(cleanup_processes.filesystem_path(destination), onexc=remove_readonly)
        (install.state_root() / 'installations/codex.json').unlink(missing_ok=True)
        provider_software.atomic(provider_software.state_path(manager), json.dumps(dict(disabled=True)).encode())


def native_executable(name, values):
    layout = windows_codex_layout() if name == 'codex' else None
    if layout:
        return Path(layout['executable'])
    return install.provider_executable(values[name])


def remove_readonly(function, path, error):
    # Agent Manager deliberately seals generated MCP artifacts read-only. On
    # Windows their read-only attribute must be cleared before deletion. Never
    # follow a reparse point or change permissions on an external link target.
    info = Path(path).lstat()
    if os.name != 'nt' or not isinstance(error, PermissionError) or not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise error
    os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
    function(path)


def erase(path, base):
    path, base = Path(path).absolute(), Path(base).absolute()
    if path == base or not path.is_relative_to(base):
        raise ValueError('Provider cleanup target is outside the Aixand workspace')
    for parent in path.parents:
        parent = cleanup_processes.filesystem_path(parent)
        if parent.is_symlink() or (parent.exists() and getattr(parent.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('Provider cleanup cannot traverse a symbolic link or junction')
    path = cleanup_processes.filesystem_path(path)
    if path.is_symlink():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path, onexc=remove_readonly)
    else:
        try:
            path.unlink(missing_ok=True)
        except PermissionError as error:
            remove_readonly(os.unlink, path, error)


def native_paths(name):
    home = Path.home()
    if name == 'codex':
        # packages/standalone can contain CLI software; account cleanup must
        # preserve it when the separate CLI checkbox is unchecked.
        root = home / '.codex'
        return [path for path in root.iterdir() if path.name != 'packages'] if root.is_dir() and not root.is_symlink() else []
    if name == 'claude':
        return [home / '.claude', home / '.claude.json', *home.glob('.claude.json.backup*')]
    if name == 'opencode':
        return [Path(os.environ['AIXAND_USER_XDG_' + kind + '_HOME']) / 'opencode'
                for kind in ('DATA', 'CONFIG', 'STATE', 'CACHE')]
    return []


def native_available(name, values):
    roots = [Path.home() / '.codex'] if name == 'codex' else native_paths(name)
    def redirected(path):
        return path.is_symlink() or (path.exists() and getattr(path.lstat(), 'st_file_attributes', 0) & 0x400)
    if any(not path.is_absolute() or not path.is_relative_to(Path.home()) or path.is_relative_to(Path(os.environ['AIXAND_LOCAL_HOME']))
           or redirected(path) or any(redirected(parent) for parent in path.parents) for path in roots):
        return False
    if name == 'opencode':
        return True
    # Keychain-backed accounts require official sign-out while the CLI exists.
    return native_executable(name, values) is not None


def sign_out_native(name, values):
    if name == 'opencode':
        return
    manager = values[name]
    executable = claude_accounts.executable(manager) if name == 'claude' else native_executable(name, values)
    if executable is None:
        raise ValueError('Restore the ' + name + ' CLI to sign out its shared native account before deletion')
    env = claude_accounts.environment(Path.home() / '.claude') if name == 'claude' else dict(os.environ, CODEX_HOME=str(Path.home() / '.codex'))
    args = ['auth', 'logout'] if name == 'claude' else ['logout']
    result = subprocess.run([str(executable), *args], env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    if result.returncode:
        raise ValueError(name + ' native account sign-out failed. Its saved files were kept; use official logout and retry.')


def managers():
    # A never-started workspace has no generated providers.toml yet.
    config = os.environ.get('AGENT_MANAGER_CONFIG')
    if config and not Path(config).exists():
        config = str(Path(os.environ['AIXAND_PROVIDER_BUNDLE_ROOT']) / 'providers.toml')
    values, _ = provider_config.load(config)
    return {name: Manager(name, config=config) for name in values}


def plan(values):
    items, revisions = [], {}
    for name, manager in values.items():
        current = software_plan(manager)
        revisions[name] = current['revision']
        if current['path']:
            items.append(dict(id='provider:' + name, group='Provider software',
                label=manager.config.get('label', name) + ' CLI', shared=True,
                available=current['automatic'], paths=current['targets'] or [current['path']],
                description=('Uninstall this provider CLI. Other applications using this installation will be affected. Saved accounts have a separate choice.'
                             if current['automatic'] else current['reason']),
                manualCommands=current['manualCommands'] if current['targets'] or current['command'] else [], docs=current.get('docs')))
            if not current['automatic'] and not current['targets'] and current['manualCommands']:
                items[-1]['description'] += ' Locate the command (this does not uninstall it): ' + '; '.join(current['manualCommands'])
    for name in ('codex', 'claude', 'opencode'):
        if name not in values:
            continue
        paths = native_paths(name)
        roots = [Path.home() / ('.codex' if name == 'codex' else '.claude')] if name != 'opencode' else paths
        if not any(path.exists() for path in paths + roots) and not native_executable(name, values):
            continue
        available = native_available(name, values)
        items.append(dict(id='native:' + name, group='Shared provider accounts',
            label=values[name].config.get('label', name) + ' shared logins and data', shared=True,
            available=available, paths=[str(path) for path in roots] + ([str(Path.home() / '.claude.json')] if name == 'claude' else []),
            description=('Sign out and erase this provider’s default native account, settings and history. This affects other applications using that account. CLI software has a separate choice.'
                         if available else 'Restore the official CLI to sign out this account before deleting its data. Shared data is retained until then.')))
    return dict(items=items, revision=revisions)


def process_targets(values, selected):
    """Use actual deletion targets, not broad display paths from the checklist."""
    base = Path(os.environ['AIXAND_LOCAL_HOME']).absolute()
    targets = []
    def add(component, paths):
        targets.extend(dict(component=component, path=str(path)) for path in paths)
    for name, manager in values.items():
        if 'native:' + name in selected:
            if not native_available(name, values):
                raise ValueError('Shared provider data cannot be checked safely. Refresh the checklist.')
            add('native:' + name, native_paths(name))
        if 'provider:' + name in selected:
            current = software_plan(manager)
            if not current['automatic']:
                raise ValueError('Provider software ownership changed. Refresh the checklist.')
            add('provider:' + name, map(Path, current['targets']))
            executable = Path(current['path'])
            # Verified POSIX vendor links and npm entrypoints are removed by
            # their owner. Include their physical payload in process detection.
            if executable.is_symlink():
                add('provider:' + name, [executable.resolve()])
            if current['method'] == 'npm':
                prefix = install.manager_prefix('npm')
                package = provider_software.PACKAGES.get(name)
                if prefix and package:
                    package_root = prefix / ('node_modules' if os.name == 'nt' else 'lib/node_modules') / package
                    if json.loads((package_root / 'package.json').read_bytes()).get('name') != package:
                        raise ValueError('Provider package changed. Refresh the checklist.')
                    add('provider:' + name, [package_root])
    if 'provider-accounts' in selected:
        root = base / 'agents'
        if root.exists():
            add('provider-accounts', [path for path in root.iterdir() if path.name != 'provider-sdks'])
        add('provider-accounts', [base / 'config/providers.toml',
            *[base / kind / 'opencode' for kind in ('data', 'config', 'state', 'cache')]])
    return targets


def reconcile_selected_runs(values, selected):
    """Release finished leases using their original runtime, never a dead PID.

    Suite stop shuts down its daemon and its administrative observers together.
    Reopen only Suite's private daemon long enough to read durable session
    outcomes. This does not relaunch providers or start an external daemon.
    """
    base = Path(os.environ['AIXAND_LOCAL_HOME']).absolute()
    private_home = base / 'uc'

    def same_path(left, right):
        return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))

    private_selected = bool(set(selected) & {'provider-accounts', 'provider-runtime', 'provider-tool-store', 'workspace'})
    affected = {name: manager for name, manager in values.items()
                if 'provider:' + name in selected or 'native:' + name in selected or
                private_selected and same_path(manager.root, base / 'agents' / name)}
    affected = {name: manager for name, manager in affected.items() if manager.state().get('runs')}
    records = [record for manager in affected.values() for record in manager.state().get('runs', {}).values()
               if record.get('runtime') == 'undercurrent' and record.get('session_id')]
    needs_private = any(record.get('connection', {}).get('home') and
                        same_path(record['connection']['home'], private_home) for record in records)
    started = False
    executable = shutil.which('uc') if needs_private else None
    env = dict(os.environ, UNDERCURRENT_HOME=str(private_home))

    def daemon(action):
        result = subprocess.run([executable, '--json', '--timeout', '30s', 'daemon', action],
                                env=env, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=40)
        if result.returncode:
            raise ValueError('Could not ' + action + ' the Aixand session observer. Nothing was removed; retry cleanup.')
        return json.loads(result.stdout)

    try:
        if needs_private:
            if executable is None:
                raise ValueError('Restore Undercurrent before checking saved provider sessions. Nothing was removed.')
            outcome = daemon('start')
            started = outcome.get('state') == 'started'
            if outcome.get('state') not in ('started', 'already_running'):
                raise ValueError('Could not verify the Aixand session observer. Nothing was removed.')
        for manager in affected.values():
            reconcile(manager)
        return [dict(path=str(manager.root), message=(manager.config.get('label', name) +
                    ' still has active or unverified agent sessions (' + ', '.join(profiles) +
                    '). Stop those agents and retry cleanup. Nothing was removed.'))
                for name, manager in affected.items() if (profiles := active_profiles(manager))]
    finally:
        if started:
            daemon('stop')


def check_processes(values, options, stopping=False):
    if stopping and (options.get('confirmed') is not True or
                     not isinstance(options.get('reviewed'), list) or not options['reviewed'] or
                     options.get('force') is True and options.get('forceConfirmed') is not True):
        raise ValueError('Confirm the listed applications before stopping them.')
    targets = [*options.get('targets', []), *process_targets(values, options['selected'])]
    report = cleanup_processes.check(
        targets,
        protected=options.get('protectedPids', []),
        reviewed=options.get('reviewed') if stopping else None,
        force=options.get('force') is True)
    if not report['blockers'] and not report['errors']:
        # Check every selected provider before the first logout or deletion.
        # A lease is not necessarily a live process or an open file.
        report['errors'].extend(reconcile_selected_runs(values, options['selected']))
    return cleanup_processes.permission_review(report, targets, Path(os.environ['AIXAND_LOCAL_HOME']), Path.home())


def repair_access(values, options):
    if options.get('confirmed') is not True or not options.get('reviewedPermissions'):
        raise ValueError('Review and confirm the selected files before administrator access repair.')
    report = check_processes(values, options)
    targets = [*options.get('targets', []), *process_targets(values, options['selected'])]
    return cleanup_processes.repair_permissions(report, targets, Path(os.environ['AIXAND_LOCAL_HOME']), options['reviewedPermissions'])


def apply(values, selected):
    base = Path(os.environ['AIXAND_LOCAL_HOME']).absolute()
    manager_home = base / 'agents'
    active = reconcile_selected_runs(values, selected)
    if active:
        return dict(completed=[], failed=' '.join(row['message'] for row in active))
    # Reused manager homes belong to other applications. Never turn the private
    # account checkbox into deletion of that external home.
    # Validate every data boundary before invoking official logouts or deleting.
    for name in ('codex', 'claude', 'opencode'):
        if 'native:' + name in selected:
            if not native_available(name, values):
                raise ValueError('Restore the official CLI and use an unredirected native provider directory before cleanup')
            for path in native_paths(name):
                if path.absolute() == Path.home() or not path.is_absolute():
                    raise ValueError('Invalid shared provider data directory')
                # A custom XDG root must still be user-owned, outside Suite.
                if not path.absolute().is_relative_to(Path.home()) or path.absolute().is_relative_to(base):
                    raise ValueError('Shared provider data is outside its user directory; remove it manually')
                for parent in path.parents:
                    if parent.is_symlink() or (parent.exists() and getattr(parent.lstat(), 'st_file_attributes', 0) & 0x400):
                        raise ValueError('Shared provider data cannot traverse a symbolic link or junction')
    if 'provider-accounts' in selected:
        claude_root = manager_home / 'claude'
        if claude_root.exists():
            if claude_root.is_symlink() or not claude_root.resolve().is_relative_to(base.resolve()):
                raise ValueError('Managed provider accounts were redirected outside Aixand')
            claude = values.get('claude')
            if claude is None or claude.root.absolute() != claude_root:
                # Reused external managers must not redirect private cleanup.
                # Sign out old Suite-owned accounts with their own configuration.
                config = base / 'config/providers.toml'
                if not config.exists():
                    config = Path(provider_config.__file__).with_name('providers.toml')
                claude = Manager('claude', config=config, root=manager_home)
            claude_accounts.prepare_reset(claude, sign_out_external=False)
    completed = []
    try:
        for name in ('codex', 'claude', 'opencode'):
            if 'native:' + name in selected:
                sign_out_native(name, values)
                for path in native_paths(name):
                    erase(path, Path.home())
                completed.append('native:' + name)
        for name, manager in values.items():
            if 'provider:' + name not in selected:
                continue
            current = software_plan(manager)
            if current.get('aixandWindowsCodex'):
                uninstall_windows_codex(manager, current)
            else:
                provider_software.perform(manager, 'uninstall', revision=current['revision'], confirmed=True)
            completed.append('provider:' + name)
        if 'provider-accounts' in selected:
            if manager_home.exists():
                for path in manager_home.iterdir():
                    if path.name != 'provider-sdks':
                        erase(path, base)
            for path in [base / 'config/providers.toml', *[base / kind / 'opencode' for kind in ('data', 'config', 'state', 'cache')]]:
                erase(path, base)
            completed.append('provider-accounts')
        return dict(completed=completed, failed=None)
    except Exception as error:
        return dict(completed=completed, failed=str(error))


def main():
    # npm/Homebrew and their subprocesses write ordinary progress to stdout.
    # Reserve the original output pipe for our JSON result at the descriptor
    # level, so vendor output cannot turn a successful removal into a parse error.
    with os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8') as protocol:
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        try:
            action = sys.argv[1]
            # Node writes UTF-8. -I ignores PYTHONIOENCODING, and a Windows
            # redirected stdin can otherwise use the system ANSI code page.
            options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else json.loads(sys.stdin.buffer.read().decode('utf-8'))
            with open(os.devnull, 'rb') as quiet_input:
                os.dup2(quiet_input.fileno(), 0)
            values = managers()
            result = (plan(values) if action == 'plan' else apply(values, options['selected']) if action == 'apply'
                      else repair_access(values, options) if action == 'repair-permissions'
                      else check_processes(values, options, action == 'stop-processes')
                      if action in ('preflight', 'stop-processes') else None)
            if result is None:
                raise ValueError('Unknown provider cleanup action')
            protocol.write(json.dumps(result) + '\n')
            return 0
        except Exception as error:
            print(str(error), file=sys.stderr)
            return 1


if __name__ == '__main__':
    sys.exit(main())
