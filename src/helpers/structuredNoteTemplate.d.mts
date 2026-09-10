export interface StructuredTemplateSection {
  id: string;
  label: string;
  type: "canonical" | "narrative";
  fieldId: string | null;
  instruction: string;
  emptyBehavior: "omit" | "blank" | "not_documented";
}
export interface StructuredNoteTemplate {
  version: 1;
  sections: StructuredTemplateSection[];
}
export function validateStructuredNoteTemplate(value: unknown): StructuredNoteTemplate;
export function migrateLegacyNoteTemplate(text: unknown): { definition: StructuredNoteTemplate | null; status: "valid" | "needs_review" };
export function renderStructuredTemplatePreview(definition: unknown): string;
