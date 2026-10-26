"""Enforce the provider boundary when assembling an Aixand application payload."""
from pathlib import Path
import shutil


def strip_provider_engines(runtime):
    runtime = Path(runtime)
    providers = runtime / 'providers'
    if providers.exists():
        shutil.rmtree(providers)
    for name in ('codex', 'claude'):
        for suffix in ('', '.exe', '.cmd', '.ps1'):
            (runtime / 'bin' / (name + suffix)).unlink(missing_ok=True)
    for path in list(runtime.rglob('claude_agent_sdk/_bundled')):
        shutil.rmtree(path)
    for path in list(runtime.rglob('google/antigravity')):
        shutil.rmtree(path)
    for path in list(runtime.rglob('google_antigravity-*.dist-info')):
        shutil.rmtree(path)
    forbidden = [path for path in runtime.rglob('*') if path.is_file() and (
        path.name.lower() in {'codex.exe', 'claude.exe', 'localharness.exe', 'localharness', 'agy', 'agy.exe'}
        or 'claude_agent_sdk/_bundled/' in path.as_posix()
        or '/node_modules/@openai/codex' in path.as_posix())]
    if forbidden:
        raise RuntimeError('Provider executables remain in Aixand payload: ' + ', '.join(str(p.relative_to(runtime)) for p in forbidden[:10]))
    notices = runtime / 'notices'
    notices.mkdir(exist_ok=True)
    (notices / 'provider-packaging.txt').write_text(
        'Aixand does not preinstall third-party provider engines or CLIs.\n'
        'Claude Agent SDK library files retain their upstream MIT license.\n'
        'Packaging change: the SDK embedded Claude Code executable is excluded.\n'
        'Provider installation is a separate user-selected setup action.\n')


if __name__ == '__main__':
    import sys
    strip_provider_engines(sys.argv[1])
