#!/usr/bin/env python3
"""Export the complete, credential-free native Windows build kit."""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', nargs='?', type=Path,
        default=ROOT/'apps/desktop/artifacts/aixand-windows-full-source.zip')
    output = parser.parse_args().output.resolve()
    spec = importlib.util.spec_from_file_location('aixand_sources', ROOT/'scripts/package-linux.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='aixand-windows-export-') as temporary:
        source = Path(temporary)/'aixand-windows'
        module.snapshot(source)
        (source/'README.txt').write_text(
            'Full native Windows build kit (x64).\n\n'
            'Open Windows PowerShell in aixand-suite and run:\n'
            '  powershell -NoProfile -ExecutionPolicy Bypass -File .\\build-windows.ps1\n\n'
            'Build prerequisites: Microsoft C++ Build Tools with Desktop development with C++, '
            'and Rust/rustup using MSVC. The script downloads its own Node/Python/uv build runtimes.\n'
            'The resulting installer bundles application runtimes and tools for end users.\n'
            'Output: %USERPROFILE%/dev/aixand-windows-build/output\n'
            'See aixand-suite/apps/web/docs/desktop.md for details and verification scope.\n', encoding='utf-8')
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source.rglob('*')):
                if path.is_file():
                    archive.write(path, path.relative_to(source.parent).as_posix())
    digest = hashlib.file_digest(output.open('rb'), 'sha256').hexdigest()
    output.with_suffix(output.suffix+'.sha256').write_text(f'{digest}  {output.name}\n', newline='\n')
    print(f'Windows full build sources: {output}\nSHA256: {digest}')


if __name__ == '__main__':
    main()
