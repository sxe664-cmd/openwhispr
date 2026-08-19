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

export interface NoteTemplateFormValues {
  name: string;
  description: string;
  templateText: string;
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

  useEffect(() => {
    if (open) setValues(initialValues);
  }, [initialValues, open]);

  const update = (field: keyof NoteTemplateFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const canSave = values.name.trim().length > 0 && values.templateText.trim().length > 0;

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
            if (canSave && !saving) onSave(values);
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
            <textarea
              id="notes-template-text"
              value={values.templateText}
              onChange={(event) => update("templateText", event.target.value)}
              placeholder={t("settingsPage.notesTemplates.templateTextPlaceholder")}
              disabled={saving}
              aria-required="true"
              spellCheck="false"
              rows={10}
              className="flex min-h-44 w-full resize-y rounded border border-border/70 bg-input px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/10 disabled:pointer-events-none disabled:opacity-50 dark:bg-surface-1 dark:border-border-subtle/50"
            />
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
