import type {} from "../types/electron";

type SourceReader = Window["electronAPI"]["getNoteGenerationSource"];

/** Preparation is owned by the background job, not by the mounted editor. */
export async function prepareNoteGenerationSource(
  noteId: number,
  read: SourceReader,
  isCancelled: () => boolean,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 500))
) {
  while (!isCancelled()) {
    const source = await read(noteId);
    if (isCancelled()) return null;
    if (!source.success || !source.sourceHash) throw Object.assign(new Error("Saved note unavailable"), { code: "SOURCE_UNAVAILABLE" });
    const pending = ["recording", "checkpointed", "finalizing"].includes(source.transcriptStatus ?? "");
    if (!pending) {
      if (source.transcript?.trim() && !source.isFinalized) {
        throw Object.assign(new Error("Saved transcript unavailable"), { code: "SOURCE_UNAVAILABLE" });
      }
      return source;
    }
    await wait();
  }
  return null;
}
