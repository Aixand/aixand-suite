import { initialOnboarding, onboardingProgressSchema, onboardingSaveSchema } from '../auth/onboarding.js';

describe('beta onboarding policy', () => {
  it('reads historical progress for reconciliation while rejecting unsupported new selections', () => {
    const progress = { ...initialOnboarding(), selected: ['claude'], current: 'claude' };
    expect(onboardingProgressSchema.safeParse(progress).success).toBe(true);
    expect(onboardingSaveSchema.safeParse({ expectedRevision: 1, progress }).success).toBe(false);
  });
  it('accepts either supported provider and rejects unsupported draft injection', () => {
    for (const provider of ['codex', 'opencode']) {
      const progress = { ...initialOnboarding(), selected: [provider], current: provider };
      expect(onboardingSaveSchema.safeParse({ expectedRevision: 1, progress }).success).toBe(true);
    }
    const progress = { ...initialOnboarding(), drafts: { claude: {
      auth: '', loginName: 'personal', profileName: 'work', operationId: null, nativeProfile: null, done: false, deferred: false,
    } } };
    expect(onboardingSaveSchema.safeParse({ expectedRevision: 1, progress }).success).toBe(false);
  });
});
