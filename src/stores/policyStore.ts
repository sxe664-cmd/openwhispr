import { create } from "zustand";
import type { PolicyDecisionSnapshot } from "./policyRules";

/**
 * Local builds have no organization policy authority. Keep the small store
 * surface used by settings and transcription guards, but make it permanently
 * unmanaged so offline startup never performs a policy request.
 */
export interface PolicyState extends PolicyDecisionSnapshot {
  accountId: null;
  authGeneration: null;
  revision: number;
  managed: false;
  fetchPolicy: (_accountId?: string, _authGeneration?: number) => Promise<void>;
  clearPolicy: () => void;
  suspendPolicy: () => void;
}

const localPolicyState = {
  status: "unmanaged" as const,
  policy: null,
  appVersion: null as string | null,
  accountId: null,
  authGeneration: null,
  revision: 0,
  managed: false as const,
};

export const usePolicyStore = create<PolicyState>()(() => ({
  ...localPolicyState,
  fetchPolicy: async () => {},
  clearPolicy: () => {},
  suspendPolicy: () => {},
}));
