// Where a streaming session's batch fallback goes. Local-first mode never
// routes audio to a hosted app service.
export function resolveStreamingFallbackTarget({
  useLocalWhisper,
}) {
  return "byok";
}
