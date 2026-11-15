import { z } from 'zod';

const provider = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const model = z.string().trim().min(1).max(256);
const cwd = z.string().trim().min(1).max(4096);
const permissionMode = z.enum(['read-only', 'workspace-write', 'workspace-auto', 'full-access']);
const profileSelection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('controller') }).strict(),
  z.object({ mode: z.literal('auto'), eligibleProfiles: z.array(name).min(1).max(128).refine((items) => new Set(items).size === items.length).optional() }).strict(),
  z.object({ mode: z.literal('specific'), profile: name }).strict(),
]);
const identity = { provider, profile: name };
const profileHome = z.string().max(256).refine((value) => {
  const parts = value.split('/');
  return parts.length === 2 && value === value.trim() && provider.safeParse(parts[0]).success && name.safeParse(parts[1]).success;
}, { message: 'Expected a provider/profile identity' });
const deviceProfileSelection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('specific'), profile: name }).strict(),
  z.object({ mode: z.literal('direct') }).strict(),
]);
const envelope = { id: z.string().uuid() };
const chatId = z.string().uuid();
const sessionId = z.union([z.string().regex(/^[a-f0-9]{64}$/), z.string().uuid(), z.string().regex(/^ses_[A-Za-z0-9]+$/)]);
const key = z.string().uuid();
const packId = z.string().regex(/^[a-f0-9]{64}$/);
const consumerId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const prompt = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const backend = z.enum(['native-codex', 'codex-acp', 'claude-acp', 'opencode-acp', 'opencode-native', 'claude-sdk', 'antigravity-sdk', 'copilot-acp', 'copilot-sdk']);
const backendProviders = { 'native-codex': 'codex', 'codex-acp': 'codex', 'claude-acp': 'claude', 'claude-sdk': 'claude',
  'opencode-acp': 'opencode', 'opencode-native': 'opencode', 'antigravity-sdk': 'antigravity', 'copilot-acp': 'copilot', 'copilot-sdk': 'copilot' };
const resourceProvider = provider;
const skillReference = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9]+(?:-[a-z0-9]+)*@(?:[A-Za-z0-9][A-Za-z0-9_.-]*|sha256:[a-f0-9]{64})$/);
const skillIdentity = z.object({ store: cwd, reference: skillReference }).strict();
const skillPolicy = z.object({ inherit: z.boolean().optional(), add: z.array(skillIdentity).max(64).optional(), exclude: z.array(skillIdentity).max(64).optional() }).strict();
const resourceId = z.string().min(1).max(512);
const filePath = z.string().min(1).max(512);
const projectPath = z.string().max(4096).refine((value) => value === '' ||
  (!value.includes('\\') && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')));
const bytes = z.string().max(48000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const operationId = z.string().min(1).max(128);
const mcpScope = z.enum(['server', 'session', 'process']);
const promptTarget = z.union([
  z.object({ kind: z.literal('managed'), publisher_id: consumerId, package_id: consumerId, prompt, revision: digest.optional() }).strict(),
  z.object({ kind: z.literal('release'), reference: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('draft'), source_id: consumerId, pack_path: cwd, prompt }).strict(),
]);
export const mcpSelectionSchema = z.object({
  inherit: z.boolean().optional(),
  add: z.array(name).max(64).optional(),
  exclude: z.array(name).max(64).optional(),
}).strict().refine((value) => !value.add?.some((name) => value.exclude?.includes(name)), {
  message: 'An MCP cannot be both added and excluded',
});
const inputs = z.record(z.string().max(128), z.unknown());
const releaseResource = z.object({ kind: z.literal('release'), store: cwd.optional(), reference: z.string().min(1).max(512) }).strict();
const managedPromptResource = z.object({ kind: z.literal('managed'), store: cwd.optional(), publisher_id: consumerId, package_id: consumerId, prompt, revision: digest.optional() }).strict();
const managedSkillResource = z.object({ kind: z.literal('managed'), store: cwd.optional(), publisher_id: consumerId, skill_id: consumerId, revision: digest.optional() }).strict();
const instructionResource = z.object({ target: z.union([managedPromptResource, releaseResource]), required: z.boolean().optional(), inputs: inputs.optional() }).strict();
const skillResource = z.object({ target: z.union([managedSkillResource, releaseResource]), required: z.boolean().optional() }).strict();
const managedMcpResource = z.object({ kind: z.literal('managed'), store: cwd.optional(), publisher_id: consumerId, server_id: consumerId, revision: digest.optional() }).strict();
const mcpTarget = z.union([name, managedMcpResource]);
const mcpResource = z.object({ target: mcpTarget, required: z.boolean().optional() }).strict();
const skillResources = z.object({ inherit: z.boolean().optional(), add: z.array(skillResource).max(64).optional(), exclude: z.array(z.union([managedSkillResource, releaseResource])).max(64).optional() }).strict();
const mcpResources = z.object({ inherit: z.boolean().optional(), add: z.array(mcpResource).max(64).optional(), exclude: z.array(mcpTarget).max(64).optional() }).strict();
export const resourceRequestSchema = z.object({ schema: z.enum(['agent-manager/resource-request-1', 'agent-manager/resource-request-2']).optional(), inherit_profile: z.boolean().optional(),
  instructions: z.union([instructionResource.extend({ mode: z.literal('replace') }).strict(), z.object({ mode: z.enum(['inherit', 'off']).optional(), inputs: inputs.optional() }).strict()]).optional(),
  skills: skillResources.optional(), mcp: mcpResources.optional(),
}).strict().refine(value => value.schema !== 'agent-manager/resource-request-1' ||
  !value.mcp?.add?.some(row => typeof row.target !== 'string') && !value.mcp?.exclude?.some(row => typeof row !== 'string'),
  { message: 'Managed MCP targets require resource-request-2' });
const resourceDefaults = z.object({ instructions: instructionResource.nullable().optional(), skills: z.array(skillResource).max(64).optional(), mcp: z.array(mcpResource).max(64).optional() }).strict();
const attributeKey = z.string().min(1).refine((value) => Buffer.byteLength(value) <= 64 && !/\p{Cc}/u.test(value));
const attributeMap = (maximum: number) => z.record(attributeKey,
  z.string().refine((value) => Buffer.byteLength(value) <= maximum && !/\p{Cc}/u.test(value)))
  .refine((value) => Object.keys(value).length <= 64);
const labelFilter = attributeMap(256);
const labels = labelFilter.refine((value) => Object.keys(value).every((key) => !key.startsWith('agent_manager.')));
const metadata = attributeMap(4096).refine((value) => Object.keys(value).every((key) => !key.startsWith('agent_manager.')));
export const agentContextSchema = z.object({ labels: labels.optional(), metadata: metadata.optional() }).strict();
const request = <const O extends string, T extends z.ZodRawShape>(op: O, args: T) =>
  z
    .object({ ...envelope, op: z.literal(op), args: z.object(args).strict() })
    .strict();

const managedId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const managedIdentity = { publisherId: managedId, resourceId: managedId, storeId: digest };
const conflictChoices = z.record(z.string().max(4096), z.union([
  z.object({ take: z.enum(['managed', 'publisher', 'baseline']) }).strict(),
  z.object({ value: z.unknown() }).strict(), z.object({ delete: z.literal(true) }).strict(),
])).refine(value => Object.keys(value).length <= 8192 && JSON.stringify(value).length <= 1024 * 1024);
const reviewOptions = { path: z.string().max(4096).optional(), expectedRevision: digest.optional(),
  conflictOffset: z.number().int().min(0).optional(),
  resolutions: conflictChoices.optional(), take: z.enum(['managed', 'publisher']).optional(),
  offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(32768).optional() };
const uploadId = z.string().regex(/^[a-f0-9]{32}$/);
function managedRequests(kind: 'prompts' | 'skills') {
  const identity = managedIdentity;
  const fileValue = kind === 'prompts' ? z.string().max(1024 * 1024).nullable()
    : z.object({ content_b64: bytes, executable: z.boolean().optional() }).strict().nullable();
  return [
    request(`${kind}-managed-list`, {}),
    request(`${kind}-managed-status`, identity),
    request(`${kind}-managed-show`, { ...identity, ...reviewOptions }),
    request(`${kind}-managed-review`, { ...identity, ...reviewOptions }),
    request(`${kind}-managed-ensure`, { ...identity, path: cwd, publisherRevision: z.number().int().min(0).optional(), version: z.string().max(128).optional() }),
    request(`${kind}-managed-adopt`, { ...identity, legacyPath: cwd, publisherPath: cwd, publisherRevision: z.number().int().min(0).optional(), version: z.string().max(128).optional(), expectedRevision: z.null() }),
    request(`${kind}-managed-save`, { ...identity, files: z.record(filePath, fileValue), expectedRevision: digest }),
    request(`${kind}-managed-apply`, { ...identity, expectedRevision: digest, resolutions: conflictChoices.optional(), take: z.enum(['managed', 'publisher']).optional() }),
    request(`${kind}-managed-history`, { ...identity, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }),
    request(`${kind}-managed-rollback`, { ...identity, expectedRevision: digest, revision: digest }),
    request(`${kind}-managed-tracking`, { ...identity, expectedRevision: digest, enabled: z.boolean() }),
    request(`${kind}-managed-release`, { ...identity, expectedRevision: digest, version: prompt }),
    request(`${kind}-managed-file`, { ...identity, expectedRevision: digest, file: filePath, offset: z.number().int().min(0).optional() }),
    request(`${kind}-managed-upload-start`, { ...identity, expectedRevision: digest, file: filePath, size: z.number().int().min(0).max(64 * 1024 * 1024), executable: z.boolean().optional() }),
    request(`${kind}-managed-upload-chunk`, { ...identity, uploadId, offset: z.number().int().min(0), content_b64: bytes }),
    request(`${kind}-managed-upload-finish`, { ...identity, uploadId, digest }),
    request(`${kind}-managed-upload-cancel`, { ...identity, uploadId }),
  ];
}

const githubOptions = { url: z.string().url().max(2048), ref: z.string().min(1).max(255).nullable().optional(), path: z.string().max(1024).nullable().optional(), track: z.boolean().nullable().optional() };
const sourceJobRequests = {
  'switch-source': z.object({ publisher: consumerId, identifier: consumerId, expected_revision: digest, ref: z.string().min(1).max(255), track: z.boolean().nullable().optional() }).strict(),
  discover: z.object(githubOptions).strict(),
  'import-github': z.object({ ...githubOptions, selections: z.array(z.string().max(1536)).min(1).max(256).nullable().optional(), role: z.enum(['system', 'user', 'assistant']).optional() }).strict(),
  import: z.object({ discovery_id: digest, selections: z.array(z.string().max(1536)).min(1).max(256).optional(), role: z.enum(['system', 'user', 'assistant']).optional() }).strict(),
  'import-local': z.object({ path: cwd }).strict(),
  create: z.object({ name: z.string().min(1).max(128), content: z.string().max(900000).optional(), description: z.string().max(4096).optional(), role: z.enum(['system', 'user', 'assistant']).optional(), definition: z.record(z.string(), z.unknown()).optional(), publisher: consumerId.optional(), resource_id: consumerId.optional() }).strict(),
  check: z.object({ publisher: consumerId, identifier: consumerId, expected_revision: digest.optional(), force: z.boolean().optional() }).strict(),
  install: z.object({ publisher: consumerId, identifier: consumerId, expected_revision: digest, candidate: z.enum(['active', 'publisher', 'reconciled']).optional(), resolutions: conflictChoices.optional(), take: z.enum(['managed', 'publisher']).optional() }).strict(),
};
function sourceRequests(kind: 'prompts' | 'skills' | 'mcp') {
  const store = { storeId: digest.optional() };
  const identity = { ...store, publisherId: consumerId, resourceId: consumerId };
  return [
    request(`${kind}-managed-source-capabilities`, store),
    request(`${kind}-managed-source-job-start`, { ...store, key, operation: z.enum(['discover', 'import', 'import-github', 'import-local', 'create', 'check', 'switch-source', 'install']), request: z.record(z.string(), z.unknown()) })
      .refine(value => sourceJobRequests[value.args.operation].safeParse(value.args.request).success && (value.args.operation !== 'install' || kind === 'mcp'), { message: 'Invalid resource source job request' }),
    request(`${kind}-managed-source-job`, { ...store, jobId: key }),
    request(`${kind}-managed-source-jobs`, store),
    request(`${kind}-managed-source-cancel`, { ...store, jobId: key }),
    request(`${kind}-managed-source-check-due`, store),
    request(`${kind}-managed-source-status`, identity),
    request(`${kind}-managed-source-settings`, { ...identity, expectedRevision: digest, pinned: z.boolean().optional(), intervalHours: z.number().int().min(1).max(720).optional(), label: z.string().trim().min(1).max(128).optional() }),
  ];
}

export const agentsRequestSchema = z.union([
  ...(['command-capabilities', 'command-workflows'] as const).map(op => request(op, {})),
  request('command-list', { before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() }),
  request('command-get', { monitorId: chatId }),
  request('command-activity', { monitorId: chatId, after: z.number().int().nonnegative().optional() }),
  request('command-create', { key, title: z.string().trim().min(1).max(120), instruction: z.string().trim().min(1).max(32000),
    projectId: chatId.optional(), supervisorChatId: chatId.optional(), profile: name.optional(), model: model.optional(), permissionMode: permissionMode.optional(),
    watches: z.array(z.object({ kind: z.enum(['chat', 'receipt', 'workflow', 'inbox', 'timer']), targetId: z.string().min(1).max(256).optional(),
      at: z.number().nonnegative().optional(), intervalSeconds: z.number().int().min(30).max(31536000).optional(), includeExisting: z.boolean().optional() }).strict()).max(64).optional(),
    limits: z.object({ maxEvaluations: z.number().int().min(1).max(10000).optional(), maxActionsPerEvaluation: z.number().int().min(1).max(200).optional(), deadline: z.number().nonnegative().optional() }).strict().optional(),
  }),
  request('command-update', { key, monitorId: chatId, expectedRevision: z.number().int().min(1),
    freshSession: z.boolean().optional(),
    instruction: z.string().trim().min(1).max(32000).optional(), direction: z.string().trim().min(1).max(32000).optional(),
    limits: z.object({ maxEvaluations: z.number().int().min(1).max(10000).optional(), maxActionsPerEvaluation: z.number().int().min(1).max(200).optional(), deadline: z.number().nonnegative().optional() }).strict().optional(),
  }),
  ...(['command-pause', 'command-resume', 'command-cancel'] as const).map(op => request(op, { key, monitorId: chatId })),
  request('command-evidence', { monitorId: chatId, evidenceId: z.string().max(256), offset: z.number().int().nonnegative().optional() }),
  request('command-action', { monitorId: chatId, actionId: chatId, offset: z.number().int().nonnegative().optional() }),
  request('command-workflow-save', { key, title: z.string().trim().min(1).max(120), workflow: z.record(z.string(), z.unknown()),
    workflowId: chatId.optional(), expectedRevision: z.number().int().min(1).optional() }),
  request('command-workflow-get', { workflowId: chatId }),
  ...sourceRequests('prompts'), ...sourceRequests('skills'), ...sourceRequests('mcp'),
  ...managedRequests('prompts'), ...managedRequests('skills'),
  request('backend-catalog', {}),
  request('backend-discovery-get', { provider, profile: name.nullable(), backend, model: model.optional(), draftId: key.optional(), projectId: key.optional(), resources: resourceRequestSchema.optional() })
    .refine(({ args }) => backendProviders[args.backend] === args.provider, { message: 'Discovery requires the matching provider backend' }),
  request('backend-discovery-refresh', { provider, profile: name.nullable(), backend, key, model: model.optional(), draftId: key.optional(), projectId: key.optional(), resources: resourceRequestSchema.optional() })
    .refine(({ args }) => backendProviders[args.backend] === args.provider, { message: 'Discovery requires the matching provider backend' }),
  request('sdk-credentials-list', { provider: z.enum(['claude', 'antigravity']) }),
  request('sdk-credential-save', { provider: z.enum(['claude', 'antigravity']), name, method: z.enum(['api-key', 'google-adc']).optional(),
    apiKey: z.string().min(1).max(16384).optional(), credentialFile: cwd.optional(), project: name.optional(),
    location: name.optional(), expectedRevision: digest.optional() }),
  request('sdk-credential-assign', { provider: z.enum(['claude', 'antigravity']), profile: name, name: name.nullable(), expectedRevision: digest.optional() }),
  request('sdk-auth-configure', { provider: z.literal('claude'), profile: name, method: z.enum(['profile-login', 'api-key']), expectedRevision: digest }),
  request('chat-backend-resume', { chatId, key }),
  request('chat-backend-history', { chatId, cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }),
  request('chat-backend-details', { chatId }),
  request('chat-backend-operation', { chatId, operationId }),
  request('chat-create-status', { key }),
  request('skills-catalog', {}),
  request('skills-source-register', { sourceId: consumerId, paths: z.array(cwd).min(1).max(16), label: z.string().max(128).optional(), writable: z.boolean().optional(), expectedRevision: digest.nullable() }),
  request('skills-source-unregister', { sourceId: consumerId, expectedRevision: digest }),
  request('skills-show', { entryId: resourceId }),
  request('skills-file', { entryId: resourceId, file: filePath }),
  request('skills-create', { sourceId: consumerId, name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), path: cwd.optional(), files: z.record(filePath, z.object({ content_b64: bytes, executable: z.boolean().optional() }).strict()) }),
  request('skills-save', { entryId: resourceId, file: filePath, content_b64: bytes, executable: z.boolean().optional(), expectedDigest: digest }),
  request('skills-validate', { entryId: resourceId }),
  request('skills-release', { entryId: resourceId, version: prompt, expectedDigest: digest }),
  request('skills-resolve', { reference: skillReference }),
  request('skills-diff', { before: resourceId, after: resourceId }),
  request('skills-profile-get', { provider: resourceProvider, profile: name }),
  request('skills-profile-set', { provider: resourceProvider, profile: name, skills: z.array(skillIdentity).max(64), expectedRevision: digest.nullable() }),
  request('skills-preview', { provider: resourceProvider, profile: name, selection: skillPolicy.optional() }),
  request('prompts-managed-create', { storeId: digest.optional(), name: consumerId, content: z.string().max(900000), role: z.enum(['system', 'user', 'assistant']).optional() }),
  request('prompts-managed-import-local', { storeId: digest.optional(), path: cwd }),
  request('prompts-source-register', { sourceId: consumerId, paths: z.array(cwd).min(1).max(16), label: z.string().max(128).optional(), writable: z.boolean().optional(), expectedRevision: digest.nullable() }),
  request('prompts-source-unregister', { sourceId: consumerId, expectedRevision: digest }),
  request('prompts-application-register', { applicationId: consumerId, prompts: z.record(prompt, promptTarget), label: z.string().max(128).optional(), fallbackPolicy: z.enum(['none', 'packaged']).optional(), expectedRevision: digest.nullable() }),
  request('prompts-application-set', { applicationId: consumerId, logicalPrompt: prompt, target: promptTarget.nullable(), expectedRevision: digest }),
  request('prompts-application-unregister', { applicationId: consumerId, expectedRevision: digest }),
  request('prompts-application-resolve', { applicationId: consumerId, logicalPrompt: prompt }),
  request('prompts-application-render', { applicationId: consumerId, logicalPrompt: prompt, inputs }),
  request('mcp-managed-inspect', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), projectId: key, revision: digest.optional() }),
  request('mcp-managed-resolve', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), revision: digest.optional() }),
  request('mcp-managed-list', {}),
  request('mcp-managed-bootstrap', {}),
  request('mcp-managed-ensure', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), definition: z.record(z.string(), z.unknown()), publisherRevision: z.number().int().nonnegative().optional(), version: z.string().max(128).optional() }),
  request('mcp-managed-adopt', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), definition: z.record(z.string(), z.unknown()), publisherRevision: z.number().int().nonnegative().optional(), version: z.string().max(128).optional(), legacyName: name }),
  request('mcp-managed-status', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional() }),
  request('mcp-managed-show', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), path: z.string().max(512).optional(), expectedRevision: digest.optional(), resolutions: z.record(z.string(), z.unknown()).optional(), take: z.enum(['managed','publisher']).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(32768).optional(), conflictOffset: z.number().int().nonnegative().optional() }),
  request('mcp-managed-review', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), path: z.string().max(512).optional(), expectedRevision: digest.optional(), resolutions: z.record(z.string(), z.unknown()).optional(), take: z.enum(['managed','publisher']).optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(32768).optional(), conflictOffset: z.number().int().nonnegative().optional() }),
  request('mcp-managed-save', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), definition: z.record(z.string(), z.unknown()), expectedRevision: digest }),
  request('mcp-managed-apply', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), expectedRevision: digest, resolutions: z.record(z.string(), z.unknown()).optional(), take: z.enum(['managed','publisher']).optional() }),
  request('mcp-managed-history', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }),
  request('mcp-managed-rollback', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), expectedRevision: digest, revision: digest }),
  request('mcp-managed-tracking', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), expectedRevision: digest, enabled: z.boolean() }),
  request('mcp-managed-file', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), expectedRevision: digest, file: z.literal('server.json'), offset: z.number().int().nonnegative().optional() }),
  request('mcp-managed-prepare', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), projectId: key, key, settings: z.record(z.string(), z.unknown()).optional(), revision: digest.optional() }),
  request('mcp-managed-refresh', { publisherId: consumerId, resourceId: consumerId, storeId: digest.optional(), projectId: key, key, settings: z.record(z.string(), z.unknown()).optional(), revision: digest.optional() }),
  request('mcp-show', { provider: resourceProvider.optional(), name }),
  request('mcp-configure', { provider: resourceProvider.optional(), name, definition: z.record(z.string(), z.unknown()), expectedRevision: digest.nullable() }),
  request('connect-status', {}),
  request('connect-configure', { apiUrl: z.string().url().max(2048), token: z.string().min(16).max(4096) }),
  request('connect-peers', {}),
  request('connect-devices', {}),
  request('connect-pair', { key, peerId: z.string().min(1).max(128), name: z.string().trim().min(1).max(128),
    port: z.number().int().min(1).max(65535).optional(), code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  request('connect-forget', { deviceId: key }),
  request('connect-transfers', { chatId: chatId.optional() }),
  request('connect-send', { key, chatId, deviceId: key, path: cwd, name: z.string().min(1).max(200).optional() }),
  request('connect-cancel', { transferId: key, chatId: chatId.optional() }),
  request('connect-check', { transferId: key, chatId: chatId.optional() }),
  request('codex-server-settings-get', {}),
  request('codex-server-settings-set', { mode: z.enum(['separate', 'shared']), expectedRevision: z.number().int().min(0) }),
  request('spawn-settings-get', {}),
  request('spawn-settings-set', { defaultMode: z.union([permissionMode, z.literal('manual')]), expectedRevision: z.number().int().min(0) }),
  request('approval-settings-get', {}),
  request('approval-settings-set', { autoApprove: z.boolean(), expectedRevision: z.number().int().min(0) }),
  request('mcp-catalog', { provider: resourceProvider.optional() }),
  request('mcp-profile-get', { provider: resourceProvider, profile: name }),
  request('mcp-profile-set', { provider: resourceProvider, profile: name, servers: z.array(name).max(64), expectedRevision: digest }),
  request('mcp-preview', { provider: resourceProvider, profile: name, projectId: key.optional(), cwd: cwd.optional(), selection: mcpSelectionSchema.optional() }),
  request('mcp-project-status', { projectId: key, check: z.boolean().optional() }),
  request('mcp-prepare', { key, projectId: key, tools: z.array(z.enum(['sonar', 'lore'])).min(1).max(2),
    refresh: z.boolean().optional(), settings: z.object({
      install_model: z.boolean().optional(), resolve: z.boolean().optional(),
      model_dir: cwd.optional(), usage_config: cwd.optional(), resources: z.enum(['none', 'yaml']).optional(),
    }).strict().optional() }),
  request('mcp-job', { jobId: key }),
  request('mcp-jobs', { projectId: key.optional() }),
  request('mcp-chat-status', { chatId, scope: mcpScope.optional(), serverName: name.optional() }),
  request('mcp-chat-reconnect', { chatId, scope: mcpScope.optional(), operationId: operationId.optional(), serverName: name.optional(), expectedSelectionDigest: digest.optional() }),
  request('prompts-catalog', {}),
  request('prompts-show', { packId, prompt: prompt.optional() }),
  request('prompts-preview', { packId, prompt, inputs }),
  request('prompts-validate', { packId }),
  request('prompts-diff', {
    packId,
    beforeId: packId,
    prompt: prompt.optional(),
    inputs: inputs.optional(),
  }),
  request('prompts-save', {
    packId,
    file: z.string().min(1).max(512),
    text: z.string().max(32000),
    expectedDigest: digest,
  }),
  request('prompts-release', {
    packId,
    version: prompt,
    expectedDigest: digest,
  }),
  request('prompts-history', {
    consumerId,
    offset: z.number().int().min(0).optional(),
  }),
  request('prompts-snapshot', { consumerId, launchId: name }),
  request('prompts-bind', {
    consumerId,
    profile: name,
    packId,
    prompt,
    inputs,
    expectedBindingDigest: digest.nullable(),
  }),
  request('prompts-unbind', {
    consumerId,
    profile: name,
    expectedBindingDigest: digest.nullable(),
  }),
  request('project-list', {}),
  request('project-files-list', { projectId: key, path: projectPath.optional(), offset: z.number().int().min(0).max(4999).optional(),
    limit: z.number().int().min(1).max(200).optional(), hidden: z.boolean().optional() }),
  request('project-file-read', { projectId: key, path: projectPath.refine((value) => value.length > 0) }),
  request('project-remove', { key, projectId: key }),
  request('project-discovery-start', {
    key, root: cwd, mode: z.enum(['preview', 'add']).optional(),
    includeNested: z.boolean().optional(),
    exclude: z.array(z.string().min(1).max(512)).max(32).optional(),
  }),
  request('project-discovery-get', { jobId: key }),
  request('project-discovery-list', {
    offset: z.number().int().min(0).max(100000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  request('project-discovery-results', {
    jobId: key, offset: z.number().int().min(0).max(100000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  request('project-discovery-cancel', { jobId: key }),
  request('project-discovery-filter', {
    key, jobId: key, scope: z.enum(['all', 'roots']).optional(),
    query: z.string().max(512).optional(),
    candidateIds: z.array(z.string().uuid()).max(2000).optional(),
  }),
  request('project-import', {
    key, jobId: key,
    selection: z.union([z.enum(['recommended', 'all', 'filtered']), z.array(z.string().uuid()).min(1).max(2000)]).optional(),
  }),
  request('project-create', {
    name: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => [...value].every((char) => char.charCodeAt(0) >= 32)),
    path: cwd,
  }),
  request('resource-catalog', { provider }),
  request('profile-resources-get', identity),
  request('profile-resources-set', { ...identity, resources: resourceDefaults, expectedRevision: digest }),
  request('launch-preview', { ...identity, resources: resourceRequestSchema.optional(), cwd: cwd.optional(), backend: backend.optional(), mode: z.enum(['backend', 'terminal']).optional(), applicationPreset: z.enum(['controller', 'worker', 'workflow', 'basic']).optional() }),
  request('suite-resource-presets', { provider: resourceProvider.optional() }),
  request('suite-tools-refresh', { key, chatId }),
  request('suite-delegated-tasks', { before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional(), chatId: chatId.optional() }),
  request('suite-delegated-task', { taskId: chatId }),
  request('suite-mcp-context', { key, chatId }),
  request('chat-connect', { provider: provider.optional(), profile: name.nullable(), cwd: cwd.optional() }),
  request('chat-list', { labels: labelFilter.optional() }),
  request('chat-mark-read', { chatId, turnId: z.string().min(1).max(512) }),
  request('chat-metadata', { chatId }),
  request('chat-create', {
    key,
    provider: provider.optional(),
    backend: backend.optional(),
    permissionMode: permissionMode.optional(),
    resources: resourceRequestSchema.optional(),
    suiteTools: z.boolean().optional(),
    toolWorkerEnvironmentId: z.string().uuid().optional(),
    toolWorkerPermissionMode: permissionMode.optional(),
    useProfileInstructions: z.boolean().optional(),
    skills: skillPolicy.optional(),
    profile: name.nullable(),
    cwd: cwd.optional(),
    mode: z.enum(['chat', 'work']),
    project: z.string().max(128).optional(),
    projectId: z.string().uuid().optional(),
    model: model.optional(),
    initialConfig: z.array(z.object({ id: z.string().min(1).max(128), value: z.union([z.string().max(512), z.boolean()]) }).strict()).max(16).optional(),
    mcp: mcpSelectionSchema.optional(),
    labels: labels.optional(),
    metadata: metadata.optional(),
    deviceId: z.string().uuid().optional(),
    remoteProfile: name.optional(),
    profileSelection: deviceProfileSelection.optional(),
  }).refine(({ args }) => !args.backend || !args.provider || backendProviders[args.backend] === args.provider, { message: 'Choose the matching provider backend' }),
  request('connect-codex-inspect', { deviceId: z.string().uuid(), cwd: cwd.optional() }),
  request('connect-managers-inspect', { deviceId: z.string().uuid() }),
  request('connect-project-copy', { key, chatId, deviceId: z.string().uuid(), projectId: z.string().uuid().optional() }),
  request('connect-project-start', { key, chatId, deviceId: z.string().uuid(), projectId: z.string().uuid().optional(),
    profileSelection: deviceProfileSelection.optional(),
    instruction: z.string().trim().min(1).max(24000).optional(), permissionMode: permissionMode.optional() }),
  request('connect-project-targets', {}),
  request('connect-project-compare', { key, chatId, deviceIds: z.array(z.string().uuid()).min(1).max(4),
    profileSelection: deviceProfileSelection.optional(),
    targetProfiles: z.array(z.object({ deviceId: z.string().uuid(), profileSelection: deviceProfileSelection }).strict()).max(4).optional(),
    includeHost: z.boolean().optional(), projectId: z.string().uuid().optional(),
    instruction: z.string().trim().min(1).max(24000).optional(), permissionMode: permissionMode.optional() }),
  request('connect-project-check', { chatId, runId: z.string().uuid(), targetId: z.string().uuid().optional() }),
  request('connect-project-cancel', { chatId, runId: z.string().uuid(), targetId: z.string().uuid().optional() }),
  request('chat-open', { chatId, around: z.string().min(1).max(512).optional(), recent: z.boolean().optional() }),
  request('chat-background', { chatId }),
  request('chat-background-agent', { chatId, agentId: z.string().min(1).max(256) }),
  request('chat-background-process', { chatId, processId: z.string().min(1).max(256) }),
  request('chat-background-stop', { key, chatId, processId: z.string().min(1).max(256) }),
  request('chat-commands', { chatId }),
  request('chat-config-confirm', { key, chatId }),
  request('chat-command', { key, chatId, command: z.string().min(1).max(256), arguments: z.string().max(24000).optional() }),
  request('chat-search', { query: z.string().max(256), project: z.string().max(512).optional(), includeTools: z.boolean().optional(), cursor: z.string().regex(/^\d{1,4}$/).optional(), limit: z.number().int().min(1).max(50).optional() }),
  request('chat-history', { chatId, around: z.string().min(1).max(512).optional(), indexed: z.boolean().optional(), before: z.string().min(1).max(512).optional(), after: z.string().min(1).max(512).optional(), limit: z.number().int().min(1).max(5).optional() })
    .refine((value) => [value.args.before, value.args.after, value.args.around].filter(Boolean).length === 1, { message: 'Choose one history direction' }),
  request('chat-voice-start', { key, chatId, sdp: z.string().min(1).max(48000).startsWith('v=0') }),
  request('chat-voice-stop', { key, chatId }),
  request('chat-terminal-open', { key, chatId }),
  request('chat-terminal-status', { chatId }),
  request('chat-terminal-release', { key, chatId }),
  request('chat-launches', { chatId }),
  request('chat-workflow-prepare', { key: z.string().min(1).max(200), workflow: z.record(z.string(), z.unknown()), workflowId: z.string().min(1).max(100).optional() }),
  request('chat-workflow-start', {
    key, chatId, projectId: z.string().uuid(), title: z.string().trim().min(1).max(120).optional(),
    permissionMode: permissionMode.optional(), sdkApprovalPolicy: z.enum(['ask', 'deny']).optional(), profileSelection: profileSelection.optional(), resources: resourceRequestSchema.optional(),
    architectureInstruction: z.string().trim().min(1).max(24000).optional(),
    securityInstruction: z.string().trim().min(1).max(24000).optional(),
    planningInstruction: z.string().trim().min(1).max(24000).optional(),
    steps: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), title: z.string().trim().min(1).max(120),
      instruction: z.string().trim().min(1).max(24000),
      permissionMode: permissionMode.optional(), sdkApprovalPolicy: z.enum(['ask', 'deny']).optional(), profileSelection: profileSelection.optional(), resources: resourceRequestSchema.optional(),
      dependsOn: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(16),
    }).strict()).min(1).max(16).optional(),
    deliveryStep: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  }).refine(({ args }) => {
    if (!args.steps) return args.deliveryStep === undefined;
    if (!args.deliveryStep || args.architectureInstruction !== undefined ||
      args.securityInstruction !== undefined || args.planningInstruction !== undefined) return false;
    const ids = new Set(args.steps.map((step) => step.id));
    if (ids.size !== args.steps.length || !ids.has(args.deliveryStep) || args.steps.some((step) =>
      new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some((id) => !ids.has(id) || id === step.id))) return false;
    const visited = new Set<string>();
    for (let pass = 0; pass < args.steps.length; pass++)
      for (const step of args.steps) if (step.dependsOn.every((id) => visited.has(id))) visited.add(step.id);
    return visited.size === ids.size;
  }, { message: 'Provide unique chat stages, acyclic dependencies, and a final delivery stage.' }),
  request('chat-workflow-list', { chatId }),
  request('chat-workflow-runs', { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional() }),
  request('chat-workflow-open', { workflowId: z.string().min(1).max(100) }),
  request('chat-workflow-status', { chatId, workflowId: z.string().min(1).max(100) }),
  request('chat-workflow-cancel', { chatId, workflowId: z.string().min(1).max(100) }),
  request('chat-workflow-resume', { chatId, workflowId: z.string().min(1).max(100) }),
  request('chat-workflow-hold', { chatId, workflowId: z.string().min(1).max(100) }),
  request('chat-workflow-enable-edits', { chatId, workflowId: z.string().min(1).max(100), key }),
  request('chat-workflow-release', { chatId, workflowId: z.string().min(1).max(100) }),
  request('chat-workflow-amend', { chatId, workflowId: z.string().min(1).max(100), key,
    expectedRevision: z.number().int().min(1), workflow: z.record(z.string(), z.unknown()), authoring: z.record(z.string(), z.unknown()).optional() }),
  request('chat-workflow-continue', { chatId, workflowId: z.string().min(1).max(100), key,
    target: z.record(z.string(), z.unknown()), inputMap: z.record(z.string(), z.string()).optional() }),
  request('chat-detach', { key, chatId }),
  request('chat-delete-preview', { chatId }),
  request('chat-delete-stop', { key, chatId, scope: z.enum(['conversation', 'subtree']), previewToken: z.string().regex(/^[a-f0-9]{64}$/), stopToken: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  request('connect-activity-list', { deviceId: z.string().uuid().optional() }),
  request('connect-activity-check', { activityId: z.string().regex(/^(project:|chat:|workflow:).{1,150}$/) }),
  request('connect-activity-stop', { key, activityId: z.string().regex(/^(project:|chat:|workflow:).{1,150}$/) }),
  request('workflow-run-action', { workflowId: z.string().min(1).max(100), action: z.enum(['status', 'cancel', 'resume', 'hold', 'release']) }),
  request('chat-delete', { key, chatId, scope: z.enum(['conversation', 'subtree']).optional(), previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional() })
    .refine(({ args }) => (args.scope === undefined) === (args.previewToken === undefined),
      { message: 'Provide both the deletion scope and its preview token.' }),
  request('workspace-reset', {
    key, scope: z.enum(['chats', 'everything']), confirmation: z.enum(['RESET CHATS', 'RESET EVERYTHING']),
    signOutExternalClaude: z.boolean().optional(),
  }).refine(({ args }) => args.confirmation === (args.scope === 'chats' ? 'RESET CHATS' : 'RESET EVERYTHING')
    && (args.signOutExternalClaude === undefined || args.scope === 'everything')),
  request('chat-send', {
    key,
    chatId,
    text: z.string().trim().min(1).max(32000),
    followupMode: z.enum(['steer', 'queue']).optional(),
  }),
  request('chat-config-set', { key, chatId, configId: z.string().min(1).max(256), value: z.union([z.string().max(512), z.boolean()]) }),
  request('chat-steer', {
    key, chatId, text: z.string().trim().min(1).max(32000),
    expectedTurnId: z.string().min(1).max(256),
  }),
  request('chat-queue', { key, chatId, text: z.string().trim().min(1).max(32000), queueMode: z.enum(['after_turn', 'next_tool_completion']).optional() }),
  request('chat-queue-edit', { key, chatId, messageId: key,
    expectedRevision: z.number().int().min(1), text: z.string().trim().min(1).max(32000) }),
  request('chat-queue-remove', { key, chatId, messageId: key, expectedRevision: z.number().int().min(1) }),
  request('chat-queue-resume', { key, chatId }),
  request('chat-interrupt', { key, chatId, expectedTurnId: z.string().min(1).max(256).optional() }),
  request('chat-answer', {
    key,
    chatId,
    // Local adapters use UUID hex; Connect companions use hyphenated UUIDs.
    // Preserve the ID exactly so the owning adapter can match its pending request.
    requestId: z.union([z.string().regex(/^[a-f0-9]{32}$/), z.string().uuid()]),
    decision: z
      .enum(['accept', 'acceptForSession', 'decline', 'cancel'])
      .optional(),
    answers: z.record(z.string().max(128), z.string().max(4000)).optional(),
    response: z.union([
      z.object({ outcome: z.literal('selected'), option_id: z.string().min(1).max(256) }).strict(),
      z.object({ outcome: z.literal('cancelled') }).strict(),
    ]).optional(),
  }),
  request('catalog', {}),
  request('agent-operations', {}),
  request('agent-profile-get', identity),
  request('agent-profile-check', identity),
  request('agent-profile-update', { ...identity, key, expectedRevision: digest, changes: z.object({
    auth: name.nullable().optional(), claudeAccountId: key.nullable().optional(),
    sdkCredential: name.nullable().optional(), sdkAuthentication: z.enum(['api-key', 'profile-login']).optional(),
    model: z.string().min(1).max(256).nullable().optional(), preferred: z.boolean().optional(), preferIfUnset: z.boolean().optional(),
  }).strict() }),
  request('agent-profile-readiness', identity),
  request('claude-accounts', {}),
  request('claude-account-create', { key, name, directory: z.string().min(1).max(4096).optional() }),
  request('claude-account-bind', { key, profile: name, accountId: key.nullable(), expectedRevision: digest }),
  request('claude-account-check', { accountId: key }),
  request('claude-account-logout', { key, accountId: key, expectedRevision: digest, confirmed: z.literal(true) }),
  request('claude-account-remove', { key, accountId: key, expectedRevision: digest, confirmed: z.literal(true) }),
  request('claude-account-migrate', { key, confirmed: z.literal(true) }),
  request('agent-management-actions', { chatId: key }),
  request('agent-management-mcp-context', { chatId: key }),
  request('agent-login-challenge', { operationId: key }),
  request('agent-operation-start', {
    key, provider, kind: z.enum(['new-login', 'reauthenticate', 'import-login', 'check-login', 'profile-login', 'install', 'install-sdk', 'setup-command', 'update', 'repair', 'uninstall', 'disable', 'enable']),
    auth: name.optional(), profile: name.optional(), device: z.boolean().optional(),
    structured: z.boolean().optional(), assignProfile: name.optional(), expectedRevision: digest.optional(),
    sourceChatId: key.optional(), sourceTurnId: z.string().max(256).optional(), sourceCallId: z.string().max(256).optional(),
    method: z.enum(['npm', 'brew', 'installer', 'browser', 'device', 'terminal']).optional(), whenIdle: z.boolean().optional(),
    installationRevision: digest.optional(), confirmed: z.literal(true).optional(),
    terminalPolicy: z.enum(['keep','prefer']).optional(),
    versionTarget: z.literal('recommended').optional(),
  }).refine(({ args }) => {
    if (args.versionTarget !== undefined && args.kind !== 'repair') return false;
    if (args.terminalPolicy !== undefined && args.kind !== 'setup-command') return false;
    const software = ['uninstall', 'disable', 'enable'].includes(args.kind);
    if (software) return !!args.installationRevision && args.confirmed === true && args.auth === undefined
      && args.profile === undefined && args.device === undefined && args.method === undefined
      && args.structured === undefined && args.assignProfile === undefined && args.expectedRevision === undefined
      && args.sourceChatId === undefined && args.sourceTurnId === undefined && args.sourceCallId === undefined;
    if (args.installationRevision !== undefined || args.confirmed !== undefined) return false;
    if (args.assignProfile !== undefined && (!['new-login', 'reauthenticate'].includes(args.kind) || !args.expectedRevision)) return false;
    if (args.structured !== undefined && !['new-login', 'reauthenticate'].includes(args.kind)) return false;
    if (args.kind === 'profile-login') return !!args.profile && args.auth === undefined && args.device === undefined
      && (args.method === undefined || ['browser', 'device', 'terminal'].includes(args.method)) && args.whenIdle === undefined;
    if (args.profile !== undefined) return false;
    const login = ['new-login', 'reauthenticate', 'import-login', 'check-login'].includes(args.kind);
    return login ? !!args.auth && args.method === undefined && args.whenIdle === undefined
      && (args.device === undefined || ['new-login', 'reauthenticate'].includes(args.kind))
      : args.auth === undefined && args.device === undefined
        && (args.method === undefined || args.kind === 'install' && ['npm', 'brew', 'installer'].includes(args.method));
  }),
  request('agent-operation-cancel', { operationId: key }),
  request('agent-operation-resolve', { operationId: key, confirmed: z.literal(true) }),
  request('providers', {}),
  request('provider-check-updates', { provider }),
  request('provider-diagnostics', { provider }),
  request('rename-login', { provider, auth: name, newName: name }),
  request('remove-login', { provider, auth: name, confirmed: z.literal(true) }),
  request('rename-profile', { ...identity, newName: name }),
  request('duplicate-profile', { ...identity, newName: name }),
  request('sessions', { labels: labelFilter.optional() }),
  request('session-list', {
    home: profileHome.optional(),
    cwd: cwd.optional(), query: z.string().trim().max(256).optional(),
    view: z.enum(['all', 'running', 'attention', 'archived']).optional(),
    offset: z.number().int().min(0).max(1000000).optional(),
    limit: z.number().int().min(1).max(50).optional(), refresh: z.boolean().optional(),
  }),
  request('session-transcript', {
    ...identity, id: sessionId,
    before: z.number().int().min(0).max(1000000000).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  request('session-start', {
    key, ...identity, expectedAuth: name.nullable(), auth: name.optional(), expectedRevision: z.string().min(1).max(200).optional(),
    environmentId: key.optional(), profileId: key.optional(), expectedEnvironmentRevision: z.string().min(1).max(200).optional(),
    suiteTools: z.boolean().optional(), projectId: key.optional(),
    prompt: z.string().trim().min(1).max(12000).refine(value => !value.includes('\0')).optional(),
    id: sessionId.optional(),
    sourceProfile: name.optional(), cwd: cwd.optional(), model: model.optional(), resources: resourceRequestSchema.optional(), mcp: mcpSelectionSchema.optional(),
  }).refine(({ args }) => Boolean(args.id || args.cwd) && (!args.sourceProfile || Boolean(args.id)), {
    message: 'Provide a saved session or a directory for a new session.',
  }).refine(({ args }) => !args.prompt || !args.id, {
    message: 'An initial prompt requires a new terminal session.',
  }),
  request('run-metadata', { provider, runId: name }),
  request('budgets', { provider, auth: name.optional() }),
  request('create-profile', {
    key: key.optional(),
    claudeAccountId: key.optional(), sdkCredential: name.optional(),
    ...identity,
    auth: name.optional(),
    model: model.optional(),
  }),
  request('delete-profile', { ...identity, confirmed: z.literal(true) }),
  request('switch-auth', { ...identity, auth: name.nullable() }),
  request('set-model', { ...identity, model: model.nullable() }),
  request('models', { ...identity, profile: name.nullable(), cwd, free: z.boolean().optional(), refresh: z.boolean().optional() })
    .refine(({ args }) => args.profile !== null || args.provider === 'codex', { message: 'Auto model discovery requires Codex' }),
  request('launch', {
    provider,
    profile: name.nullable(),
    cwd,
    resources: resourceRequestSchema.optional(),
    model: model.optional(),
    mcp: mcpSelectionSchema.optional(),
    labels: labels.optional(),
    metadata: metadata.optional(),
  }),
  request('get', { provider, runId: name }),
  request('stop', { provider, runId: name, force: z.boolean().optional() }),
  request('reconcile', { provider }),
]);
export type AgentsRequest = z.infer<typeof agentsRequestSchema>;
