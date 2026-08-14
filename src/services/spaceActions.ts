import { loadSpaces, purgeSpace, updateSpaceMeta } from "../stores/noteStore";

/** Local-only space mutations. Team membership and cloud mirroring are gone. */
export async function renameSpace(id: number, name: string, emoji?: string | null) {
  return updateSpaceMeta(id, { name, emoji });
}

export async function deleteSpace(id: number) {
  const result = await purgeSpace(id);
  if (result.success) await loadSpaces();
  return result;
}

export async function createSpace(): Promise<never> {
  throw new Error("Creating hosted spaces is unavailable in local-first mode");
}

export async function assignTeamToSpace(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function setSpaceTeamAccess(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function unassignTeamFromSpace(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function addTeamMembers(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function removeTeamMember(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function setTeamMemberRole(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function leaveTeam(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}

export async function deleteTeam(): Promise<never> {
  throw new Error("Team spaces are unavailable in local-first mode");
}
