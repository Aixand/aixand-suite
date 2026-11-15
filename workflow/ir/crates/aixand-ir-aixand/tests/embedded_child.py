"""Trusted regression fixture: real subprocesses, optional private SDK imports."""
import ctypes
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys

ctypes.pythonapi.Py_GetProgramName.restype = ctypes.c_wchar_p
identity = dict(executable=sys.executable, base_executable=sys._base_executable,
                prefix=sys.prefix, base_prefix=sys.base_prefix,
                program_name=ctypes.pythonapi.Py_GetProgramName(),
                write_bytecode=not sys.dont_write_bytecode)
if os.environ.get('AIXAND_EMBEDDED_TEST_SDK') == '1':
    identity['sdk_imported'] = bool(importlib.import_module('aixand'))
fixture = os.environ.get('AIXAND_EMBEDDED_TEST_FIXTURE')
if fixture:
    identity['environment_fixture'] = importlib.import_module('embedded_environment_fixture').identity
code = '''import importlib, json, os, subprocess, sys
module = subprocess.run([sys.executable, '-I', '-B', '-m', 'json.tool'],
                        input='{"module_launched":true}', text=True, capture_output=True)
assert module.returncode == 0, module.stderr
result = dict(executable=sys.executable, base_executable=sys._base_executable,
              prefix=sys.prefix, base_prefix=sys.base_prefix, module=json.loads(module.stdout))
if os.environ.get('AIXAND_EMBEDDED_TEST_SDK') == '1':
    result['sdk_imported'] = bool(importlib.import_module('aixand'))
if os.environ.get('AIXAND_EMBEDDED_TEST_FIXTURE'):
    result['environment_fixture'] = importlib.import_module('embedded_environment_fixture').identity
print(json.dumps(result))
'''
allowed = [Path(os.environ[name]).resolve() for name in
           ('AIXAND_EMBEDDED_TEST_PYTHON', 'AIXAND_EMBEDDED_HOST_BINARY')]
if Path(sys.executable).resolve() not in allowed:
    result = dict(identity=identity, exit=-1, stdout='',
                  stderr='Refused to execute Python selected outside the private fixture')
else:
    child = subprocess.run([sys.executable, '-I', '-B', '-c', code],
                           text=True, capture_output=True, timeout=20)
    result = dict(identity=identity, exit=child.returncode, stdout=child.stdout, stderr=child.stderr)
