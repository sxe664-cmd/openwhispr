import { create } from "zustand";
import type {
  EnterpriseSetupMode,
  ManagedEnterpriseConfig,
  ManagedEnterpriseScopeResolution,
} from "../types/enterpriseIdentity";
import type { InferenceScope } from "../config/inferenceScopes";

interface EnterpriseIdentityState {
  accountId: string | null;
  workspaceId: string | null;
  authGeneration: number | null;
  status: "idle";
  config: ManagedEnterpriseConfig | null;
  error: null;
  failClosed: false;
  refresh: (
    accountId: string,
    workspaceId: string,
    authGeneration: number,
    forceRefresh?: boolean
  ) => Promise<void>;
  clear: () => void;
}

export const useEnterpriseIdentityStore = create<EnterpriseIdentityState>((set) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  status: "idle",
  config: null,
  error: null,
  failClosed: false,
  refresh: async () => {
    // Managed enterprise identity is a hosted feature and is disabled.
  },
  clear: () =>
    set({ accountId: null, workspaceId: null, authGeneration: null, config: null }),
}));

/** Local-first mode always resolves inference to the user's local/BYOK setup. */
export function getManagedScopeResolution(
  _scope: InferenceScope,
  _setupMode: EnterpriseSetupMode
): ManagedEnterpriseScopeResolution {
  return { kind: "manual" };
}

export function useManagedScopeResolution(
  _scope: InferenceScope,
  _setupMode: EnterpriseSetupMode
): ManagedEnterpriseScopeResolution {
  return { kind: "manual" };
}
