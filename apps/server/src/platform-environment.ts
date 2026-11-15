/** OS prerequisites for narrowly scoped child environments. */
export function platformEnvironment(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const result: NodeJS.ProcessEnv = { OS: 'Windows_NT', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) result[key] = process.env[key];
  return result;
}
