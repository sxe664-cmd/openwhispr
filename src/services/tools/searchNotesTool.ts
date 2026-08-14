import type { SpaceItem } from "../../types/electron";
import type { ContainerScope } from "../../types/chat";
import type { ToolDefinition, ToolResult } from "./ToolRegistry";
import { resolveSpace } from "./utils";

const MAX_CONTENT_LENGTH = 500;

interface SearchToolOptions {
  fixedScope?: ContainerScope;
}

export function createSearchNotesTool(options: SearchToolOptions): ToolDefinition {
  const { fixedScope } = options;
  const spaceParameter = fixedScope
    ? {}
    : { space: { type: "string", description: "Space name to search within." } };

  return {
    name: "search_notes",
    description: "Search the user's local notes using semantic search with a local keyword fallback.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to find relevant notes" },
        limit: { type: "number", description: "Maximum number of results (default 5)" },
        ...spaceParameter,
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const query = args.query as string;
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
      let space: SpaceItem | undefined;
      if (fixedScope) {
        space = spaces.find((candidate) => candidate.id === fixedScope.spaceId);
      } else if (typeof args.space === "string") {
        const resolved = resolveSpace(spaces, args.space);
        if (resolved.error) return { success: false, data: null, displayText: resolved.error };
        space = resolved.space;
      }
      const spaceId = fixedScope?.spaceId ?? space?.id ?? null;
      const folderId = fixedScope?.folderId ?? null;
      try {
        return await executeLocalSearch(query, limit, true, space, spaces, spaceId, folderId);
      } catch {
        return executeLocalSearch(query, limit, false, space, spaces, spaceId, folderId);
      }
    },
  };
}

async function executeLocalSearch(
  query: string,
  limit: number,
  semantic: boolean,
  space: SpaceItem | undefined,
  spaces: SpaceItem[],
  spaceId: number | null,
  folderId: number | null
): Promise<ToolResult> {
  const notes = semantic
    ? await window.electronAPI.semanticSearchNotes(query, limit, spaceId, folderId)
    : await window.electronAPI.searchNotes(query, limit, spaceId, folderId);
  const names = new Map(spaces.map((candidate) => [candidate.id, candidate.name]));
  const results = notes.map((note) => ({
    id: note.id,
    title: note.title,
    date: note.created_at,
    type: note.note_type,
    space: names.get(note.space_id) ?? null,
    content: (note.enhanced_content || note.content).slice(0, MAX_CONTENT_LENGTH),
  }));
  const scope = space ? ` in ${space.name}` : "";
  return {
    success: true,
    data: results,
    displayText:
      results.length === 0
        ? `No notes found for "${query}"${scope}`
        : `Found ${results.length} note${results.length === 1 ? "" : "s"} for "${query}"${scope}${semantic ? " (semantic search)" : ""}`,
  };
}
