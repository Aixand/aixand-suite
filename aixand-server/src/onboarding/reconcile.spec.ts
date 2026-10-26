import { initialOnboarding } from '../auth/onboarding.js';
import { reconcileProgress, type ProviderInventory } from './reconcile.js';

describe('removed onboarding providers', () => {
  const inventory: ProviderInventory = { schema: 'agent-manager/provider-catalog-1', configured: false,
    inventoryComplete: true, providers: [{ provider: 'antigravity', available: true, profiles: [] }] };
  const progress = () => ({ ...initialOnboarding(), selected: ['gemini'], current: 'gemini',
    selectionInitialized: true, selectionExplicit: true, step: 'login' as const,
    drafts: { gemini: { auth: '', profileName: 'work', loginName: 'personal', operationId: 'old-sign-in',
      nativeProfile: 'work', done: false, deferred: false } } });

  it('returns to agent selection when a removed provider was the only selection', () => {
    const saved = progress();
    const observed = reconcileProgress(saved, inventory, [], { operations: [] });
    expect(observed).toMatchObject({ selected: [], current: null, step: 'providers', drafts: {} });
    expect(saved.selected).toEqual(['gemini']);
  });

  it('keeps selections when the provider inventory is incomplete or the provider is unavailable', () => {
    const saved = progress();
    expect(reconcileProgress(saved, { ...inventory, inventoryComplete: false }, [], { operations: [] })).toEqual(saved);
    const observed = reconcileProgress(saved, { ...inventory, providers: [{ provider: 'gemini', available: false, profiles: [] }] }, [], { operations: [] });
    expect(observed.selected).toEqual(saved.selected);
    expect(observed.drafts).toEqual(saved.drafts);
  });
});
