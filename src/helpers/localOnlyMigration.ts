import { useSettingsStore } from "../stores/settingsStore";

const MIGRATION_KEY = "localOnlyMigrationV1";

/** Remove hosted-account state while preserving local data, models, and BYOK credentials. */
export function runLocalOnlyMigration(): void {
  const settings = useSettingsStore.getState();
  const legacyMode = (key: string): boolean => localStorage.getItem(key) === "openwhispr";

  if (legacyMode("transcriptionMode")) {
    settings.setTranscriptionMode("local");
    settings.setUseLocalWhisper(true);
  }
  if (legacyMode("meetingTranscriptionMode")) {
    settings.setMeetingTranscriptionMode("local");
  }
  if (legacyMode("uploadTranscriptionMode")) {
    settings.setUploadTranscriptionMode("local");
  }
  if (settings.cloudTranscriptionMode === "openwhispr") {
    settings.setCloudTranscriptionMode("byok");
  }
  if (settings.cleanupCloudMode === "openwhispr") {
    settings.setCleanupCloudMode("providers");
  }
  if (legacyMode("cleanupMode")) settings.setCleanupMode("local");
  if (settings.cleanupMode === "enterprise") settings.setCleanupMode("local");
  if (legacyMode("noteFormattingMode")) settings.setNoteFormattingMode("local");
  if (settings.noteFormattingMode === "enterprise") settings.setNoteFormattingMode("local");
  if (legacyMode("translationMode")) settings.setTranslationMode("local");
  if (settings.translationMode === "enterprise") settings.setTranslationMode("local");
  if (legacyMode("chatAgentMode")) settings.setChatAgentMode("local");
  if (settings.chatAgentMode === "enterprise") settings.setChatAgentMode("local");
  if (legacyMode("dictationAgentMode")) settings.setDictationAgentMode("local");
  if (settings.dictationAgentMode === "enterprise") settings.setDictationAgentMode("local");
  if (legacyMode("dictationAgentVisionMode")) {
    settings.setDictationAgentVisionMode("providers");
  }
  if (settings.dictationAgentVisionMode === "enterprise") {
    settings.setDictationAgentVisionMode("providers");
  }
  if (settings.translationCloudMode === "openwhispr") settings.setTranslationCloudMode("byok");
  if (settings.chatAgentCloudMode === "openwhispr") settings.setChatAgentCloudMode("byok");
  if (settings.dictationAgentCloudMode === "openwhispr") {
    settings.setDictationAgentCloudMode("byok");
  }
  if (settings.dictationAgentVisionCloudMode === "openwhispr") {
    settings.setDictationAgentVisionCloudMode("byok");
  }
  localStorage.removeItem("isSignedIn");
  localStorage.removeItem("authenticationSkipped");
  localStorage.removeItem("skipAuth");
  localStorage.removeItem("pendingCloudMigration");
  localStorage.removeItem("cloudMigrationShown");
  localStorage.removeItem("upgradeProDismissed");

  if (localStorage.getItem(MIGRATION_KEY) !== "true") {
    localStorage.setItem(MIGRATION_KEY, "true");
  }
}
