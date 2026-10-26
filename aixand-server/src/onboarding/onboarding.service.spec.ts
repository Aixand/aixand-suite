import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AuthStore, initializeAuthDatabase } from '../auth/store.js';
import { initialOnboarding, type OnboardingProgress } from '../auth/onboarding.js';
import type { AuthService } from '../auth/auth.service.js';
import type { AgentsService } from '../agents/agents.service.js';
import { FilesystemService } from '../filesystem/filesystem.service.js';
import { OnboardingService } from './onboarding.service.js';
import type { ProviderInventory, Operations } from './reconcile.js';

describe('onboarding coordinator', () => {
  let root: string, store: AuthStore, service: OnboardingService;
  let projects: { id: string; name: string; path: string }[], configured: boolean, inventoryComplete: boolean, ready: boolean;
  let failure: string, lostReply: boolean, creates: number;
  let providers: ProviderInventory['providers'], operations: Operations['operations'], calls: string[];
  let duringDiscovery: (() => void) | undefined;
  const request = {} as IncomingMessage;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'suite-onboarding-'));
    initializeAuthDatabase(join(root, 'auth.db')); store = new AuthStore(join(root, 'auth.db'));
    projects = []; configured = false; inventoryComplete = true; ready = true; failure = ''; lostReply = false; creates = 0;
    providers = []; operations = []; calls = []; duringDiscovery = undefined;
    const auth = {
      onboarding: () => store.onboarding(), assertOnboardingMutation: () => {},
      beginOnboarding: () => { store.beginOnboarding(); return store.onboarding(); },
      saveOnboarding: (_request: unknown, progress: OnboardingProgress, revision: number) => {
        const result = store.saveOnboarding(progress, revision);
        if (!result) throw new Error('revision conflict');
        return result;
      },
    } as unknown as AuthService;
    const agents = { request: async ({ op, args }: { op: string; args: Record<string, string> }) => {
      calls.push(op);
      if (op === 'providers') { duringDiscovery?.(); return { type: 'result', result: { schema: 'agent-manager/provider-catalog-1', configured, inventoryComplete, providers } }; }
      if (op === 'project-list') return { type: 'result', result: [...projects] };
      if (op === 'agent-operations') return { type: 'result', result: { operations } };
      if (op === 'agent-profile-get') return { type: 'result', result: { identity: 'profile-id', auth: 'personal' } };
      if (op === 'agent-profile-readiness') return { type: 'result', result: { ready, reason: 'Sign in required.' } };
      if (op === 'project-create') {
        creates++;
        if (args.name === failure) return { type: 'error', message: 'Registration failed.' };
        const project = { id: randomUUID(), name: args.name, path: args.path }; projects.push(project);
        return lostReply ? { type: 'error', message: 'Lost reply.' } : { type: 'result', result: project };
      }
      throw new Error('Unexpected operation ' + op);
    } } as unknown as AgentsService;
    service = new OnboardingService(auth, agents, new FilesystemService());
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  function draft(names: string[]) {
    store.beginOnboarding();
    return store.saveOnboarding({ ...initialOnboarding(), selected: ['example'], current: 'example', step: 'projects',
      drafts: { example: { auth: 'personal', profileName: 'work', loginName: 'personal', operationId: null, nativeProfile: null, done: true, deferred: false } },
      projects: { directory: root, skipped: false, entries: names.map(name => {
        const path = join(root, name); mkdirSync(path); return { id: path, path, name };
      }) } }, store.onboarding()!.revision)!;
  }
  it('distinguishes empty installations, existing configuration and failed discovery', async () => {
    expect((await service.status(request)).needed).toBe(true);
    configured = true; expect((await service.status(request)).needed).toBe(false);
    configured = false; inventoryComplete = false;
    await expect(service.status(request)).rejects.toThrow('could not be checked');
  });
  it('validates Manager readiness even when the client says its profile is done', async () => {
    const state = draft([]); ready = false;
    await expect(service.complete(request, state.revision, true)).rejects.toThrow('Sign in required');
    expect(store.onboarding()!.status).toBe('pending');
  });
  it('persists partial registration and only retries the missing project', async () => {
    const state = draft(['first', 'second']); failure = 'second';
    const partial = await service.complete(request, state.revision, false);
    expect(partial.status).toBe('pending');
    expect(partial.projects!.entries[0].projectId).toBe(projects[0].id);
    expect(partial.projects!.entries[1].error).toContain('failed');
    failure = '';
    const complete = await service.complete(request, partial.revision, false);
    expect(complete.status).toBe('complete'); expect(projects).toHaveLength(2); expect(creates).toBe(3);
  });
  it('reconciles a committed project when the reply was lost', async () => {
    const state = draft(['first']); lostReply = true;
    expect((await service.complete(request, state.revision, false)).status).toBe('complete');
    expect(creates).toBe(1);
  });
  it('requires explicit skip for empty projects and rejects stale completion', async () => {
    const state = draft([]);
    await expect(service.complete(request, state.revision - 1, true)).rejects.toThrow('Setup changed');
    await expect(service.complete(request, state.revision, false)).rejects.toThrow('Choose project');
    const complete = await service.complete(request, state.revision, true);
    expect(complete.projects!.skipped).toBe(true);
    expect(complete.status).toBe('complete');
  });

  function existingProfile() {
    configured = true;
    providers = [{ provider: 'example', available: true, authentication: { authMode: 'files' },
      profiles: [{ profile: 'work', auth: 'personal', identity: 'existing-profile', readiness: { ready: true } }] }];
  }
  it('adopts ready Manager profiles into an untouched pending wizard and only leaves projects', async () => {
    store.beginOnboarding(); existingProfile();
    const original = store.onboarding()!;
    const observation = await service.status(request);
    expect(observation.reason).toBe('projects');
    expect(store.onboarding()!.revision).toBe(original.revision); // GET is read-only.
    const reconciled = await service.reconcile(request, original.revision);
    expect(reconciled).toMatchObject({ status: 'pending', step: 'projects', selected: ['example'], selectionInitialized: true,
      drafts: { example: { profileName: 'work', auth: 'personal', profileIdentity: 'existing-profile', done: true } } });
    expect((await service.reconcile(request, reconciled.revision)).revision).toBe(reconciled.revision);
    expect(calls.every(op => ['providers', 'project-list', 'agent-operations'].includes(op))).toBe(true);
  });
  it('clears stale onboarding for an already configured workspace without creating anything', async () => {
    store.beginOnboarding(); existingProfile();
    projects.push({ id: randomUUID(), name: 'Existing project', path: root });
    const state = await service.reconcile(request, store.onboarding()!.revision);
    expect(state.status).toBe('complete'); expect(state.step).toBe('done'); expect(creates).toBe(0);
  });
  it('preserves selected folders, names and failures until those projects are actually registered', async () => {
    const state = draft(['first', 'second']); existingProfile();
    const entries = state.projects!.entries;
    projects.push({ id: randomUUID(), name: 'first', path: entries[0].path });
    entries[1].error = 'Registration failed';
    const { revision, ...progress } = state;
    const saved = store.saveOnboarding(progress, revision)!;
    const reconciled = await service.reconcile(request, saved.revision);
    expect(reconciled.status).toBe('pending'); expect(reconciled.step).toBe('projects');
    expect(reconciled.projects!.entries[0].projectId).toBe(projects[0].id);
    expect(reconciled.projects!.entries[1]).toEqual(entries[1]); expect(creates).toBe(0);
    projects.push({ id: randomUUID(), name: 'second', path: entries[1].path });
    const complete = await service.reconcile(request, reconciled.revision);
    expect(complete.status).toBe('complete'); expect(complete.projects!.entries[1].error).toBeUndefined();
  });
  it('does not close manually reopened setup when existing projects satisfy first-run setup', async () => {
    const state = draft([]); existingProfile(); projects.push({ id: randomUUID(), name: 'Existing project', path: root });
    const { revision, ...progress } = state;
    const saved = store.saveOnboarding({ ...progress, manual: true }, revision)!;
    expect(await service.reconcile(request, saved.revision)).toMatchObject({ manual: true, status: 'pending', step: 'projects' });
  });
  it('keeps an explicit new profile choice instead of replacing it with another ready profile', async () => {
    const state = draft([]); existingProfile();
    providers[0].profiles[0].profile = 'other';
    const saved = await service.reconcile(request, state.revision);
    expect(saved).toMatchObject({ step: 'profile', drafts: { example: { profileName: 'work', done: false } } });
  });
  it('migrates old automatic CLI selections to ready profiles and defers untouched providers', async () => {
    existingProfile();
    providers[0].profiles[0].profile = 'main';
    providers.push({ provider: 'native', available: true, authentication: { authMode: 'native' },
      profiles: [{ profile: 'default', auth: null, identity: 'native-profile', readiness: { ready: true } }] },
      { provider: 'unused', available: true, profiles: [{ profile: 'default', auth: null, identity: 'empty-profile', readiness: { ready: false } }] });
    store.beginOnboarding();
    const state = store.onboarding()!;
    const untouched = { auth: '', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null, done: false, deferred: false };
    const saved = store.saveOnboarding({ ...initialOnboarding(), selectionInitialized: true, selected: ['example', 'native', 'unused'],
      step: 'login', drafts: { native: untouched } }, state.revision)!;
    const result = await service.reconcile(request, saved.revision);
    expect(result.step).toBe('projects');
    expect(result.drafts.example).toMatchObject({ profileName: 'main', done: true });
    expect(result.drafts.native).toMatchObject({ profileName: 'default', nativeProfile: 'default', done: true });
    expect(result.drafts.unused).toMatchObject({ deferred: true, done: false });
  });
  it('keeps explicitly selected providers and edited default profile names as unfinished work', async () => {
    existingProfile(); providers[0].profiles[0].profile = 'main';
    providers.push({ provider: 'new-agent', available: true, profiles: [] });
    store.beginOnboarding();
    const { revision } = store.onboarding()!;
    const saved = store.saveOnboarding({ ...initialOnboarding(), selectionInitialized: true, selectionExplicit: true,
      selected: ['example', 'new-agent'], step: 'login', drafts: {} }, revision)!;
    expect((await service.reconcile(request, saved.revision)).step).toBe('login');
    const { revision: updated, ...progress } = store.onboarding()!;
    progress.drafts.example = { auth: '', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null,
      profileEdited: true, done: false, deferred: false };
    const edited = store.saveOnboarding({ ...progress, selectionExplicit: false }, updated)!;
    const result = await service.reconcile(request, edited.revision);
    expect(result.drafts.example).toMatchObject({ profileName: 'work', profileEdited: true, done: false, deferred: false });
    expect(result.drafts['new-agent']).toBeUndefined();
  });
  it('does not accept a replacement profile with the same name or forget deferred selections', async () => {
    const state = draft([]); existingProfile();
    providers.push({ provider: 'later', available: false, profiles: [] });
    const { revision, ...progress } = state;
    progress.drafts.example.profileIdentity = 'previous-profile';
    progress.selected.push('later'); progress.drafts.later = { ...progress.drafts.example, deferred: true };
    const saved = store.saveOnboarding(progress, revision)!;
    const result = await service.reconcile(request, saved.revision);
    expect(result.drafts.example).toMatchObject({ done: false, profileIdentity: 'previous-profile' });
    expect(result.drafts.later).toEqual(progress.drafts.later); expect(result.selected).toEqual(progress.selected);
  });
  it.each(['running', 'uncertain'])('keeps %s operations pending even when a profile currently appears ready', async status => {
    const state = draft([]); existingProfile(); operations = [{ provider: 'example', status }];
    const saved = await service.reconcile(request, state.revision);
    expect(saved.step).toBe('profile'); expect(saved.drafts.example.done).toBe(false);
  });
  it('does not treat a named but unready profile as completed setup', async () => {
    store.beginOnboarding(); existingProfile(); providers[0].profiles[0].readiness!.ready = false;
    const state = store.onboarding()!;
    expect(await service.reconcile(request, state.revision)).toEqual(state);
  });
  it('keeps the pending record on failed discovery and rejects edits made during a check', async () => {
    store.beginOnboarding(); const state = store.onboarding()!;
    inventoryComplete = false;
    await expect(service.reconcile(request, state.revision)).rejects.toThrow('could not be checked');
    expect(store.onboarding()).toEqual(state);
    inventoryComplete = true; existingProfile();
    duringDiscovery = () => { const { revision, ...progress } = store.onboarding()!;
      store.saveOnboarding({ ...progress, selectionInitialized: true, selected: [] }, revision); };
    await expect(service.reconcile(request, state.revision)).rejects.toThrow('Setup changed');
    expect(store.onboarding()!.selected).toEqual([]);
  });
});
