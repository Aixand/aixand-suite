import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingMessage } from 'node:http';
import { AgentsService } from '../agents/agents.service.js';
import type { AgentsRequest } from '../agents/protocol.js';
import { AuthService } from '../auth/auth.service.js';
import { onboardingProviderSupported, type OnboardingProgress } from '../auth/onboarding.js';
import { FilesystemService } from '../filesystem/filesystem.service.js';
import { chatSupportInstalled, reconcileProgress, type ProviderInventory, type Project, type Operations } from './reconcile.js';

@Injectable()
export class OnboardingService {
  private completing = false;
  constructor(@Inject(AuthService) private auth: AuthService, @Inject(AgentsService) private agents: AgentsService,
    @Inject(FilesystemService) private fs: FilesystemService) {}
  private async call<T>(op: string, args: object = {}): Promise<T> {
    const result = await this.agents.request({ id: randomUUID(), op, args } as AgentsRequest);
    if (result.type !== 'result') throw new ServiceUnavailableException(result.message ?? 'Agent Manager is unavailable.');
    return result.result as T;
  }
  async status(request: IncomingMessage) {
    const progress = this.auth.onboarding(request);
    const [inventory, projects] = await Promise.all([
      this.call<ProviderInventory>('providers'), this.call<Project[]>('project-list'),
    ]);
    if (inventory.schema !== 'agent-manager/provider-catalog-1')
      throw new ServiceUnavailableException('Update Agent Manager to use live setup.');
    if (!inventory.inventoryComplete && !inventory.configured && projects.length === 0)
      throw new ServiceUnavailableException('Some provider configuration could not be checked. Refresh setup after checking Agent Manager.');
    if (progress?.status === 'pending') {
      const { revision, ...saved } = progress;
      const observed = reconcileProgress(saved, inventory, projects, await this.call<Operations>('agent-operations'));
      return { needed: observed.status === 'pending', reason: observed.status === 'complete' ? 'configured' : observed.step === 'projects' ? 'projects' : 'agents',
        progress: { ...observed, revision } };
    }
    return { needed: !inventory.configured && projects.length === 0, reason: 'empty', progress };
  }
  async reconcile(request: IncomingMessage, expectedRevision: number) {
    this.auth.assertOnboardingMutation(request);
    if (this.completing) throw new ConflictException('Setup is being completed. Refresh its progress.');
    const current = this.auth.onboarding(request);
    if (!current || current.revision !== expectedRevision) throw new ConflictException('Setup changed. Refresh before checking its progress.');
    if (current.status !== 'pending') return current;
    const observed = (await this.status(request)).progress!;
    const { revision, ...progress } = observed;
    const latest = this.auth.onboarding(request)!;
    const { revision: latestRevision, ...saved } = latest;
    if (isDeepStrictEqual(saved, progress)) return latest;
    if (latestRevision !== expectedRevision || revision !== expectedRevision)
      throw new ConflictException('Setup changed. Refresh before checking its progress.');
    return this.auth.saveOnboarding(request, progress, expectedRevision, true);
  }
  async start(request: IncomingMessage, manual = false) {
    this.auth.assertOnboardingMutation(request);
    if (manual) return this.auth.beginOnboarding(request, true);
    const state = await this.status(request);
    const current = this.auth.onboarding(request);
    if (current?.status === 'pending') return this.reconcile(request, current.revision);
    return state.needed ? this.auth.beginOnboarding(request) : state.progress;
  }
  async complete(request: IncomingMessage, expectedRevision: number, skipProjects: boolean) {
    this.auth.assertOnboardingMutation(request);
    if (this.completing) throw new ConflictException('Setup is already being completed. Refresh its progress.');
    this.completing = true;
    try {
      let state = this.auth.onboarding(request);
      if (!state || state.revision !== expectedRevision) throw new ConflictException('Setup changed. Refresh before finishing.');
      if (state.status === 'complete') return state;
      const active = state.selected.filter(provider => !state!.drafts[provider]?.deferred);
      if (active.some(provider => !onboardingProviderSupported(provider)))
        throw new BadRequestException('Choose Codex or OpenCode before finishing setup.');
      if (!active.length) throw new BadRequestException('Set up at least one agent before finishing.');
      const [jobs, inventory] = await Promise.all([
        this.call<Operations>('agent-operations'), this.call<ProviderInventory>('providers'),
      ]);
      if (inventory.schema !== 'agent-manager/provider-catalog-1')
        throw new ServiceUnavailableException('Update Agent Manager to use live setup.');
      for (const provider of active) {
        const draft = state.drafts[provider];
        if (!draft?.profileName) throw new BadRequestException('Choose a profile for every selected agent.');
        if (jobs.operations.some(job => job.provider === provider && ['queued', 'starting', 'running', 'uncertain'].includes(job.status)))
          throw new BadRequestException('Finish or resolve the current agent operation before continuing.');
        const observedProvider = inventory.providers.find(row => row.provider === provider);
        if (!observedProvider?.available)
          throw new BadRequestException(`Refresh the ${provider} installation before continuing.`);
        if (!chatSupportInstalled(observedProvider))
          throw new BadRequestException(`Finish installing chat support for ${provider} before continuing.`);
        const profile = await this.call<{ identity: string; auth: string | null }>('agent-profile-get', { provider, profile: draft.profileName });
        if (draft.profileIdentity && profile.identity !== draft.profileIdentity)
          throw new ConflictException('A selected profile was replaced. Select it again before finishing.');
        if (draft.auth && profile.auth !== draft.auth)
          throw new ConflictException('A selected profile’s account changed. Refresh agent setup.');
        const ready = await this.call<{ ready: boolean; reason?: string }>('agent-profile-readiness', { provider, profile: draft.profileName });
        if (!ready.ready) throw new BadRequestException(ready.reason ?? 'This agent still needs setup.');
        state.drafts[provider] = { ...draft, done: true, profileIdentity: profile.identity };
      }
      const projects = state.projects ?? { directory: '', entries: [], skipped: false };
      if (!skipProjects && projects.entries.length === 0) throw new BadRequestException('Choose project folders or skip this step.');
      if (!skipProjects) {
        const names = projects.entries.map(row => row.name.trim().toLowerCase());
        if (names.some(name => !name) || new Set(names).size !== names.length)
          throw new BadRequestException('Give each selected project a distinct name.');
      }
      let registered = await this.call<Project[]>('project-list');
      const entries = projects.entries.map(row => ({ ...row }));
      if (!skipProjects) for (const entry of entries) {
        delete entry.error;
        try {
          const path = await this.fs.directory(entry.path);
          const existing = registered.find(row => row.path === path);
          const project = existing ?? await this.call<Project>('project-create', { name: entry.name.trim(), path });
          entry.projectId = project.id; entry.path = path; entry.name = project.name;
          if (!existing) registered.push(project);
        } catch (error) {
          // A lost reply may follow a committed registration. Reconcile before any retry.
          try { registered = await this.call<Project[]>('project-list'); } catch { /* Keep the uncertain result visible. */ }
          const existing = registered.find(row => row.path === entry.path && row.name === entry.name.trim());
          if (existing) entry.projectId = existing.id;
          else entry.error = error instanceof Error ? error.message.slice(0, 2048) : 'Project could not be registered.';
        }
        const { revision: savedRevision, ...savedProgress } = state;
        state = this.auth.saveOnboarding(request, { ...savedProgress, projects: { ...projects, entries }, version: 2 } as OnboardingProgress, savedRevision);
      }
      if (entries.some(row => row.error) && !skipProjects) return state;
      const { revision, ...progress } = state;
      return this.auth.saveOnboarding(request, { ...progress, version: 2, status: 'complete', step: 'done',
        projects: { ...projects, entries, skipped: skipProjects } }, revision, true);
    } finally { this.completing = false; }
  }
}
