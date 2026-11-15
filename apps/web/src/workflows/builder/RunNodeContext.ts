import { createContext } from 'react'

export type RunNodeDetails = {
  state: string; statusLabel: string; kindLabel: string; detail: string;
  meta?: string; open?: () => void; actionLabel?: string;
  selection?: { permissionMode?: import('../../agents/permissions').PermissionMode; permissionSource?: string;
    sdkApprovalPolicy?: 'ask' | 'deny';
    requested?: import('../../agents/profileSelection').ProfileSelection; decision?: import('../../agents/profileSelection').ProfileDecision | null };
}
export const RunNodeContext = createContext<Record<string, RunNodeDetails>>({})
