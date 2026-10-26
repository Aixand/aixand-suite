import { z } from 'zod';

const provider = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const name = z.string().max(128);
const extra = z.object({
  mode: z.enum(['account', 'profile']).nullable(),
  resumeMode: z.enum(['account', 'profile']).optional(),
  auth: name,
  loginName: name,
  profileName: name,
  operationId: z.uuid().nullable(),
  profileRequestId: z.uuid().optional(),
  nativeProfile: name.nullable(),
}).strict();
const draft = z.object({
  auth: name,
  loginName: name,
  profileName: name,
  operationId: z.uuid().nullable(),
  profileRequestId: z.uuid().optional(),
  profileIdentity: z.string().max(128).optional(),
  profileEdited: z.boolean().optional(),
  nativeProfile: name.nullable(),
  done: z.boolean(),
  deferred: z.boolean(),
  extra: extra.nullable().optional(),
}).strict();

export const onboardingProgressSchema = z.object({
  version: z.literal(2).optional(),
  manual: z.boolean().optional(),
  status: z.enum(['pending', 'complete']),
  step: z.enum(['providers', 'install', 'login', 'profile', 'projects', 'done']),
  selected: z.array(provider).max(128).refine(items => new Set(items).size === items.length),
  selectionInitialized: z.boolean(),
  selectionExplicit: z.boolean().optional(),
  current: provider.nullable(),
  drafts: z.record(provider, draft),
  projects: z.object({
    directory: z.string().max(4096),
    skipped: z.boolean(),
    entries: z.array(z.object({
      id: z.string().min(1).max(4096), path: z.string().min(1).max(4096), name: z.string().max(128),
      projectId: z.uuid().optional(), error: z.string().max(2048).optional(),
    }).strict()).max(200),
  }).strict().optional(),
}).strict().refine(value => value.status !== 'complete' || value.step === 'done'
  && value.selected.some(provider => value.drafts[provider]?.done), 'Finish at least one profile before completing setup.');

export const onboardingSaveSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  progress: onboardingProgressSchema,
}).strict();

export type OnboardingProgress = z.infer<typeof onboardingProgressSchema>;
export type OnboardingState = OnboardingProgress & { revision: number };
export const initialOnboarding = (): OnboardingProgress => ({
  status: 'pending', step: 'providers', selected: [], selectionInitialized: false, current: null, drafts: {},
});
