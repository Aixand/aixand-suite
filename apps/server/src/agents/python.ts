import { platformEnvironment } from '../platform-environment.js';
import { existsSync } from 'node:fs';
import { dirname, delimiter, resolve } from 'node:path';
import { authDatabasePath } from '../auth/config.js';

/** Trusted server configuration shared by the chat and recovery processes. */
export function agentPython() {
  const prepared = resolve(process.platform === 'win32' ? '../../.venv/Scripts/python.exe' : '../../.venv/bin/python');
  const python = process.env.AGENTS_PYTHON ?? (existsSync(prepared) ? prepared : 'python3');
  const env: NodeJS.ProcessEnv = { ...platformEnvironment(), PATH: process.env.PATH, HOME: process.env.HOME };
  env.AIXAND_AUTH_DATABASE = authDatabasePath();
  if (process.env.AIXAND_PACKAGED_RUNTIME === '1') {
    env.PYTHONNOUSERSITE = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
  }
  for (const key of [
    'AGENT_MANAGER_HOME', 'AGENT_MANAGER_CONFIG', 'AGENT_MANAGER_HOMES_ROOT', 'AIXAND_MANAGER_ROOT', 'AGENT_MANAGER_LABELS', 'AGENT_MANAGER_METADATA',
    'SKILL_MANAGER_HOME', 'SKILLS_SOURCE_PATHS', 'MCP_MANAGER_HOME', 'CONVERSATION_MANAGER_HOME',
    'SUITE_CHAT_PROVIDERS', 'PROMPT_MANAGER_HOME', 'PROMPT_MANAGER_PACKS', 'PROMPTS_PACK_PATHS',
    'UNDERCURRENT_HOME', 'UNDERCURRENT_PYTHON_BRIDGE', 'AGENTS_CWD', 'AIXAND_CONNECT_SOURCE',
    'AGENTS_STATE_DIR', 'AGENTS_SCRATCH_DIR', 'AGENTS_WORKSPACE_TOOLS', 'SUITE_WORKFLOW_SOCKET',
    'SUITE_RECOVERY_SOCKET', 'WORKFLOW_RUNNER_HOME', 'RUNNER_HOME', 'CARRIER_URL', 'CARRIER_DATABASE',
    'CARRIER_STATE_DIR', 'CARRIER_WORKSPACE_ID', 'CARRIER_USER_ADDRESS', 'CARRIER_USER_CREDENTIALS',
    'CARRIER_AUTO_PROVISION', 'TERMINAL_CWD', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'AIXAND_PACKAGED_RUNTIME', 'AIXAND_PROVIDER_BUNDLE_ROOT', 'npm_config_prefix', 'npm_config_cache',
    'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR',
  ]) if (process.env[key]) env[key] = process.env[key];
  if ((python.includes('/') || python.includes('\\'))) env.PATH = `${dirname(resolve(python))}${delimiter}${env.PATH ?? ''}`;
  env.PYTHONPATH = process.env.AIXAND_PACKAGED_RUNTIME === '1' ? '' : [
    process.env.AGENTS_MANAGER_SOURCE,
    process.env.AGENTS_RUNTIME_SOURCE,
    process.env.PROMPTS_MANAGER_SOURCE,
    process.env.SKILLS_MANAGER_SOURCE,
    process.env.MCPS_MANAGER_SOURCE,
    process.env.CONVERSATIONS_MANAGER_SOURCE,
    process.env.FILESYSTEM_SOURCE,
    process.env.LOCAL_RUNTIME_SOURCE,
    process.env.GITHUB_SOURCE,
    process.env.CARRIER_SOURCE,
    process.env.AIXAND_CONNECT_SOURCE ?? resolve('../../services/connect'),
    process.env.ORCHESTRATION_MCP_SOURCE ?? resolve('../../mcps/orchestration/src'),
  ].filter(Boolean).join(delimiter);
  return { python, env };
}
