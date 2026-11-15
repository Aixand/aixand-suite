"""Relocate the private Python dependency of macOS embedded consumers."""
import re


def python_dependencies(output):
    # Skip otool's filename header; preserve spaces in absolute build paths.
    return [line.strip().split(' (compatibility version ', 1)[0]
            for line in output.splitlines()[1:]
            if re.fullmatch(r'libpython\d+\.\d+\.dylib',
                line.strip().split(' (compatibility version ', 1)[0].rsplit('/', 1)[-1])]


def relocate(binary, run):
    dependencies = python_dependencies(run('otool', '-L', binary, capture=True))
    if len(dependencies) != 1:
        raise RuntimeError(f'Expected one embedded Python dependency: {binary}: {dependencies}')
    old = dependencies[0]
    target = '@rpath/' + old.rsplit('/', 1)[-1]
    if old != target:
        run('install_name_tool', '-change', old, target, binary)
    rpath = '@loader_path/../python/lib'
    commands = run('otool', '-l', binary, capture=True)
    if not re.search(r'^\s*path ' + re.escape(rpath) + r' \(offset \d+\)$', commands, re.M):
        run('install_name_tool', '-add_rpath', rpath, binary)
    run('codesign', '--force', '--sign', '-', binary)


def library_id(python, run):
    for library in (python / 'lib').glob('libpython*.*.dylib'):
        if library.is_symlink():
            continue
        run('install_name_tool', '-id', '@rpath/' + library.name, library)
        run('codesign', '--force', '--sign', '-', library)
