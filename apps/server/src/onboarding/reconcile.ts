import { onboardingProviderSupported, type OnboardingProgress } from '../auth/onboarding.js';

export type Project = { id: string; name: string; path: string };
type Profile = { profile: string; identity: string; auth: string | null; readiness?: { ready: boolean } };
export type ProviderInventory = {
  schema: string; configured: boolean; inventoryComplete: boolean;
  providers: { provider: string; available: boolean; profiles: Profile[]; authentication?: { authMode: string };
    sdkInstallations?: { available: boolean; required?: boolean }[]; terminalCommand?: { ready: boolean } | null;
    chatCompatibility?: { compatible: boolean } | null }[];
};
export type Operations = { operations: { provider: string; status: string }[] };
export const chatSupportInstalled = (provider?: ProviderInventory['providers'][number]) =>
  (provider?.chatCompatibility?.compatible ?? true) && (provider?.sdkInstallations ?? []).every(sdk => sdk.required === false || sdk.available) && (provider?.terminalCommand?.ready ?? true);

/** Reconcile observations only: never install, sign in, create a profile or register a folder. */
export function reconcileProgress(progress: OnboardingProgress, inventory: ProviderInventory,
  registered: Project[], jobs: Operations): OnboardingProgress {
  if (progress.status !== 'pending') return progress;
  const next = structuredClone(progress);
  inventory = { ...inventory, providers: inventory.providers.filter(row => onboardingProviderSupported(row.provider)) };
  next.selected = next.selected.filter(onboardingProviderSupported);
  for (const provider of Object.keys(next.drafts)) {
    if (!onboardingProviderSupported(provider)) delete next.drafts[provider];
  }
  if (next.current && !onboardingProviderSupported(next.current)) next.current = next.selected[0] ?? null;
  if (progress.selected.length && !next.selected.length) next.step = 'providers';
  if (inventory.inventoryComplete) {
    const providers = new Set(inventory.providers.map(row => row.provider));
    next.selected = next.selected.filter(provider => providers.has(provider));
    for (const provider of Object.keys(next.drafts)) {
      if (!providers.has(provider)) delete next.drafts[provider];
    }
    if (next.current && !providers.has(next.current)) next.current = next.selected[0] ?? null;
    if (progress.selected.length && !next.selected.length) next.step = 'providers';
  }
  const busy = new Set(jobs.operations.filter(job => ['queued', 'starting', 'running', 'uncertain'].includes(job.status)).map(job => job.provider));
  const preferred = (profiles: Profile[]) => profiles.find(row => row.profile !== 'default' && row.readiness?.ready)
    ?? profiles.find(row => row.readiness?.ready);
  const untouched = (draft: OnboardingProgress['drafts'][string] | undefined) => !draft ||
    !draft.profileEdited && !draft.profileIdentity && !draft.profileRequestId && !draft.auth && !draft.nativeProfile
    && !draft.operationId && !draft.done && !draft.deferred && !draft.extra && draft.profileName === 'work' && draft.loginName === 'personal';
  // An untouched wizard can adopt the existing workspace. Explicit selections,
  // including deferred providers and a different draft profile name, remain intact.
  if (!next.selectionInitialized && !next.selected.length) {
    next.selected = inventory.providers.filter(row => row.available && chatSupportInstalled(row) && !busy.has(row.provider) && preferred(row.profiles)).map(row => row.provider).slice(0, 128);
    if (next.selected.length) next.selectionInitialized = true;
  }
  for (const provider of next.selected) {
    const draft = next.drafts[provider];
    if (draft?.deferred) continue;
    const info = inventory.providers.find(row => row.provider === provider);
    const profile = draft?.profileIdentity ? info?.profiles.find(row => row.identity === draft.profileIdentity)
      : untouched(draft) ? preferred(info?.profiles ?? []) : info?.profiles.find(row => row.profile === draft?.profileName);
    const native = info?.authentication?.authMode === 'native';
    if (native && draft) draft.auth = '';
    const ready = info?.available && chatSupportInstalled(info) && !busy.has(provider) && profile?.readiness?.ready
      && (native || !draft?.auth || draft.auth === profile.auth);
    if (!ready || !profile) {
      if (draft) draft.done = false;
      continue;
    }
    next.drafts[provider] = { ...(draft ?? { loginName: 'personal', operationId: null, deferred: false }),
      auth: profile.auth ?? '', profileName: profile.profile, profileIdentity: profile.identity,
      nativeProfile: info.authentication?.authMode === 'native' ? profile.profile : null, done: true };
  }
  // Older onboarding preselected every installed CLI. Once usable profiles are
  // found, those untouched defaults are optional, not additional requirements.
  if (!next.selectionExplicit && next.selected.some(provider => next.drafts[provider]?.done)) {
    for (const provider of next.selected) {
      const info = inventory.providers.find(row => row.provider === provider);
      if (!next.drafts[provider]?.done && untouched(progress.drafts[provider]) && info?.available && !busy.has(provider))
        next.drafts[provider] = { ...(next.drafts[provider] ?? { auth: '', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null,
          done: false }), deferred: true };
    }
  }
  const active = next.selected.filter(provider => !next.drafts[provider]?.deferred);
  const unfinished = active.find(provider => !next.drafts[provider]?.done);
  if (!active.length || unfinished || active.some(provider => next.drafts[provider]?.extra?.mode)) {
    if (next.step === 'projects' || next.step === 'done') {
      next.step = 'profile'; next.current = unfinished ?? active[0] ?? null;
    }
    return next;
  }
  next.current = active.includes(next.current ?? '') ? next.current : active[0];
  next.step = 'projects';
  const projects = next.projects;
  let registeredSelections = true;
  for (const entry of projects?.entries ?? []) {
    const existing = registered.find(row => row.path === entry.path && row.name === entry.name.trim()
      && (!entry.projectId || row.id === entry.projectId));
    if (existing) { entry.projectId = existing.id; delete entry.error; }
    else registeredSelections = false;
  }
  const projectsDone = projects?.skipped || (projects?.entries.length ? registeredSelections : registered.length > 0);
  // Manually reopening setup is an explicit opportunity to add more agents or
  // projects. It stays open even when the existing workspace is already usable.
  if (projectsDone && !next.manual) {
    next.status = 'complete'; next.step = 'done'; next.version = 2;
  }
  return next;
}
