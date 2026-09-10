import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { NoteTemplate } from "../../types/electron";
import { CLINICAL_ENCOUNTER_TEMPLATE, parseClinicalEncounterTemplatePresentation } from "../../services/clinicalEncounterTemplateEngine";
import {
  migrateLegacyNoteTemplate,
  renderStructuredTemplatePreview,
  validateStructuredNoteTemplate,
  type StructuredNoteTemplate,
  type StructuredTemplateSection,
} from "../../helpers/structuredNoteTemplate.mjs";

export interface NoteTemplateFormValues {
  name: string;
  description: string;
  templateText: string;
  structuredDefinition?: unknown;
}

interface NotesTemplatesEditorProps {
  open: boolean;
  mode: "create" | "edit";
  template: NoteTemplate | null;
  initialValues: NoteTemplateFormValues;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (values: NoteTemplateFormValues) => void;
}

export default function NotesTemplatesEditor({
  open,
  mode,
  template,
  initialValues,
  saving,
  onOpenChange,
  onSave,
}: NotesTemplatesEditorProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<NoteTemplateFormValues>(initialValues);
  const [definition, setDefinition] = useState<StructuredNoteTemplate>({ version: 1, sections: [] });

  useEffect(() => {
    if (!open) return;
    setValues(initialValues);
    try {
      if (initialValues.structuredDefinition) {
        setDefinition(validateStructuredNoteTemplate(initialValues.structuredDefinition));
        return;
      }
      const legacy = parseClinicalEncounterTemplatePresentation(initialValues.templateText);
      setDefinition({ version: 1, sections: legacy.sections.flatMap((section) => section.fields.map((field) => ({
        id: `${section.id}-${field.id}`, label: `${section.label} — ${field.label}`,
        type: "canonical" as const, fieldId: `${section.id}.${field.id}`, instruction: "", emptyBehavior: "not_documented" as const,
      }))) });
    } catch {
      setDefinition(migrateLegacyNoteTemplate(initialValues.templateText).definition ?? { version: 1, sections: [] });
    }
  }, [initialValues, open]);

  const update = (field: keyof NoteTemplateFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const updateSection = (id: string, patch: Partial<StructuredTemplateSection>) => {
    setDefinition((current) => ({ ...current, sections: current.sections.map((section) => section.id === id ? { ...section, ...patch } : section) }));
  };
  const moveSection = (index: number, direction: number) => {
    setDefinition((current) => {
      const sections = [...current.sections];
      const target = index + direction;
      if (target < 0 || target >= sections.length) return current;
      [sections[index], sections[target]] = [sections[target], sections[index]];
      return { ...current, sections };
    });
  };
  const canSave = values.name.trim().length > 0 && definition.sections.length > 0 && definition.sections.every((section) => section.label.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t(
              mode === "edit"
                ? "settingsPage.notesTemplates.editTitle"
                : "settingsPage.notesTemplates.newTitle"
            )}
          </DialogTitle>
          <DialogDescription>
            {template?.is_builtin
              ? t("settingsPage.notesTemplates.builtInEditDescription")
              : mode === "edit" && !values.templateText
                ? t("settingsPage.notesTemplates.pasteExistingDescription")
                : t("settingsPage.notesTemplates.editorDescription")}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !saving) onSave({ ...values, structuredDefinition: definition, templateText: renderStructuredTemplatePreview(definition) });
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="notes-template-name" className="text-xs font-medium text-foreground">
              {t("settingsPage.notesTemplates.name")}
            </label>
            <Input
              id="notes-template-name"
              value={values.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder={t("settingsPage.notesTemplates.namePlaceholder")}
              autoFocus
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="notes-template-description"
              className="text-xs font-medium text-foreground"
            >
              {t("settingsPage.notesTemplates.descriptionLabel")}
            </label>
            <Input
              id="notes-template-description"
              value={values.description}
              onChange={(event) => update("description", event.target.value)}
              placeholder={t("settingsPage.notesTemplates.descriptionPlaceholder")}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="notes-template-text"
              className="text-xs font-medium text-foreground"
            >
              {t("settingsPage.notesTemplates.templateText")}
            </label>
            <div className="space-y-3">
              {definition.sections.map((section, index) => (
                <div key={section.id} className="space-y-2 border-b border-border/50 pb-3">
                  <div className="flex items-center gap-2">
                    <Input aria-label={`Section ${index + 1} label`} value={section.label} maxLength={200} disabled={saving} onChange={(event) => updateSection(section.id, { label: event.target.value })} />
                    <Button type="button" variant="ghost" disabled={saving || index === 0} aria-label="Move section up" onClick={() => moveSection(index, -1)}>↑</Button>
                    <Button type="button" variant="ghost" disabled={saving || index === definition.sections.length - 1} aria-label="Move section down" onClick={() => moveSection(index, 1)}>↓</Button>
                    <Button type="button" variant="ghost" disabled={saving} onClick={() => setDefinition((current) => ({ ...current, sections: current.sections.filter((item) => item.id !== section.id) }))}>Remove</Button>
                  </div>
                  <select aria-label={`${section.label} content`} className="w-full rounded border border-border bg-background p-2 text-xs" disabled={saving} value={section.fieldId ?? "narrative"} onChange={(event) => updateSection(section.id, { type: event.target.value === "narrative" ? "narrative" : "canonical", fieldId: event.target.value === "narrative" ? null : event.target.value })}>
                    <option value="narrative">Custom narrative</option>
                    {CLINICAL_ENCOUNTER_TEMPLATE.sections.map((group) => <optgroup key={group.key} label={group.label}>{group.fields.map((field) => <option key={field.key} value={`${group.key}.${field.key}`}>{field.label}</option>)}</optgroup>)}
                  </select>
                  <Input aria-label={`${section.label} instruction`} placeholder="Optional instruction — what belongs in this section?" maxLength={1000} disabled={saving} value={section.instruction} onChange={(event) => updateSection(section.id, { instruction: event.target.value })} />
                  <select aria-label={`${section.label} when empty`} className="rounded border border-border bg-background p-1 text-xs" disabled={saving} value={section.emptyBehavior} onChange={(event) => updateSection(section.id, { emptyBehavior: event.target.value as StructuredTemplateSection["emptyBehavior"] })}>
                    <option value="not_documented">When empty: Not documented</option><option value="omit">When empty: omit section</option><option value="blank">When empty: leave blank</option>
                  </select>
                </div>
              ))}
              <Button type="button" variant="outline" disabled={saving || definition.sections.length >= 256} onClick={() => setDefinition((current) => ({ ...current, sections: [...current.sections, { id: crypto.randomUUID(), label: "New section", type: "narrative", fieldId: null, instruction: "", emptyBehavior: "not_documented" }] }))}>Add section</Button>
              {canSave && <details className="text-xs"><summary className="cursor-pointer">Preview layout</summary><pre className="mt-2 whitespace-pre-wrap">{renderStructuredTemplatePreview(definition)}</pre></details>}
            </div>
            <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Original template text</summary><textarea
              id="notes-template-text"
              value={values.templateText}
              readOnly
              placeholder={t("settingsPage.notesTemplates.templateTextPlaceholder")}
              disabled={saving}
              aria-required="true"
              spellCheck="false"
              rows={10}
              className="flex min-h-44 w-full resize-y rounded border border-border/70 bg-input px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/10 disabled:pointer-events-none disabled:opacity-50 dark:bg-surface-1 dark:border-border-subtle/50"
            /></details>
            <p className="text-xs leading-relaxed text-muted-foreground/80">
              {t("settingsPage.notesTemplates.editorHelp")}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              {t("settingsPage.notesTemplates.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave || saving}>
              {saving
                ? t("settingsPage.notesTemplates.saving")
                : t(
                    mode === "edit"
                      ? "settingsPage.notesTemplates.saveRevision"
                      : "settingsPage.notesTemplates.create"
                  )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
