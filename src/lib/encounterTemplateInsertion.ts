export function insertEncounterTemplate(currentContent: string, templateText: string): string {
  const template = templateText.trim();
  if (!template) return currentContent;

  return currentContent.trim()
    ? `${currentContent.trimEnd()}\n\n${template}`
    : template;
}
