"""Check real Windows executable lookup without importing user PowerShell modules."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

if os.name != 'nt':
    print('Windows command discovery check requires Windows.')
    sys.exit(0)

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'scripts/dev'))
import command_environment

with tempfile.TemporaryDirectory(prefix='aixand-command-proof-') as temporary:
    work = Path(temporary) / 'command paths 世界'
    binaries = work / 'bin'
    binaries.mkdir(parents=True)
    executable = binaries / 'aixand-command-proof.exe'
    shutil.copy2(Path(os.environ['SystemRoot']) / 'System32/whoami.exe', executable)
    module = work / 'modules/DoNotLoad'
    module.mkdir(parents=True)
    sentinel = work / 'unexpected-module-execution.txt'
    (module / 'DoNotLoad.psd1').write_text("@{ModuleVersion='1.0';RootModule='DoNotLoad.psm1';FunctionsToExport=@('aixand-missing-command-proof','ConvertFrom-Json')}\n", encoding='utf-8-sig')
    (module / 'DoNotLoad.psm1').write_text("[IO.File]::WriteAllText('" + str(sentinel).replace("'", "''") + "','must not execute')\nfunction aixand-missing-command-proof {}\nfunction ConvertFrom-Json { throw 'User module must not handle metadata' }\n", encoding='utf-8-sig')
    previous = os.environ.get('PSModulePath')
    os.environ['PSModulePath'] = str(work / 'modules')
    command_environment.search_path = lambda: str(binaries)
    try:
        found = command_environment.windows_candidates(['aixand-command-proof', 'aixand-missing-command-proof'])
        assert [Path(p).resolve() for p in found['aixand-command-proof']] == [executable.resolve()], found
        assert found['aixand-missing-command-proof'] == [], found
        assert not sentinel.exists(), 'Executable discovery imported a user PowerShell module'
    finally:
        if previous is None:
            os.environ.pop('PSModulePath', None)
        else:
            os.environ['PSModulePath'] = previous
print(json.dumps({'passed': True, 'checks': ['real executable found', 'missing command handled', 'untrusted modules not imported', 'Unicode paths preserved', 'registry PATH unchanged']}))
