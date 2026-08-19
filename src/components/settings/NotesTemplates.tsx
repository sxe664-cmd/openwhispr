import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CopyPlus, FileText, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import type { NoteTemplate } from "../../types/electron";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button } from "../ui/button";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import NotesTemplatesEditor, {
  type NoteTemplateFormValues,
} from "./NotesTemplatesEditor";

type EditorMode = "create" | "edit";

const EMPTY_FORM: NoteTemplateFormValues = {
  name: "",
  description: "",
  templateText: "",
};

function getTemplateError(result: { code?: string; error?: string } | undefined) {
  return result?.error || result?.code || "Unknown error";
}

export default function NotesTemplates() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const templatesEnabled = useSettingsStore((state) => state.encounterEnhancedNotesEnabled);
  const setTemplatesEnabled = useSettingsStore(
    (state) => state.setEncounterEnhancedNotesEnabled
  );

  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiAvailable, setApiAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyTemplateId, setBusyTemplateId] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("create");
  const [editorTemplate, setEditorTemplate] = useState<NoteTemplate | null>(null);
  const [editorValues, setEditorValues] = useState<NoteTemplateFormValues>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NoteTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadTemplates = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.listNoteTemplates) {
      setApiAvailable(false);
      setLoading(false);
      return;
    }

    setApiAvailable(true);
    setLoading(true);
    setError(null);
    try {
      const [listedTemplates, defaultTemplate] = await Promise.all([
        api.listNoteTemplates("encounter"),
        api.getDefaultNoteTemplate?.("encounter") ?? Promise.resolve(null),
      ]);
      const encounterTemplates = Array.isArray(listedTemplates) ? listedTemplates : [];
      const selectedDefault = defaultTemplate ?? encounterTemplates.find((template) => template.is_default);
      setTemplates(encounterTemplates);
      setDefaultTemplateId(selectedDefault?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const defaultTemplate = useMemo(
    () => templates.find((template) => template.id === defaultTemplateId) ?? null,
    [defaultTemplateId, templates]
  );

  const showUnavailableToast = useCallback(() => {
    toast({
      title: t("settingsPage.notesTemplates.unavailableTitle"),
      description: t("settingsPage.notesTemplates.unavailableDescription"),
      variant: "default",
    });
  }, [t, toast]);

  const openCreate = () => {
    setEditorMode("create");
    setEditorTemplate(null);
    setEditorValues(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openWithTemplateText = async (template: NoteTemplate, mode: EditorMode) => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api?.getNoteTemplate) {
      showUnavailableToast();
      return;
    }
    try {
      const rawTemplate = await api.getNoteTemplate(template.id, { includeRaw: true });
      if (typeof rawTemplate?.template_text !== "string") {
        toast({
          title: t("settingsPage.notesTemplates.edit"),
          description: "The template body could not be loaded.",
          variant: "destructive",
        });
        return;
      }
      setEditorMode(mode);
      setEditorTemplate(mode === "edit" ? template : null);
      setEditorValues({
        name: mode === "edit" ? template.name : `${template.name} ${t("settingsPage.notesTemplates.copySuffix")}`,
        description: template.description,
        templateText: rawTemplate.template_text,
      });
      setEditorOpen(true);
    } catch (loadError) {
      toast({
        title: t("settingsPage.notesTemplates.edit"),
        description: loadError instanceof Error ? loadError.message : String(loadError),
        variant: "destructive",
      });
    }
  };

  const openEdit = (template: NoteTemplate) => {
    void openWithTemplateText(template, "edit");
  };

  const openDuplicate = (template: NoteTemplate) => {
    void openWithTemplateText(template, "create");
  };

  const handleSave = async (values: NoteTemplateFormValues) => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (
      !apiAvailable ||
      !api ||
      (editorMode === "edit" ? !api.updateNoteTemplate : !api.createNoteTemplate)
    ) {
      showUnavailableToast();
      return;
    }

    setSaving(true);
    try {
      const result =
        editorMode === "edit" && editorTemplate
          ? await api.updateNoteTemplate!(editorTemplate.id, {
              name: values.name.trim(),
              description: values.description.trim(),
              templateText: values.templateText.trim(),
            })
          : await api.createNoteTemplate!({
              name: values.name.trim(),
              description: values.description.trim(),
              kind: "encounter",
              templateText: values.templateText.trim(),
            });

      if (!result?.success) {
        toast({
          title: t("settingsPage.notesTemplates.saveFailed"),
          description: getTemplateError(result),
          variant: "destructive",
        });
        return;
      }

      setEditorOpen(false);
      toast({
        title: t(
          editorMode === "edit"
            ? "settingsPage.notesTemplates.revisionSaved"
            : "settingsPage.notesTemplates.templateCreated"
        ),
        description: t("settingsPage.notesTemplates.pastNotesUnchanged"),
        variant: "success",
      });
      await loadTemplates();
    } catch (saveError) {
      toast({
        title: t("settingsPage.notesTemplates.saveFailed"),
        description: saveError instanceof Error ? saveError.message : String(saveError),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (templateId: number) => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    const template = templates.find((item) => item.id === templateId);
    if (!template || !apiAvailable || !api?.setDefaultNoteTemplate) {
      showUnavailableToast();
      return;
    }

    setBusyTemplateId(templateId);
    try {
      if (api.activateNoteTemplate) {
        const activation = await api.activateNoteTemplate(templateId, template.active_revision_id);
        if (!activation.success) {
          toast({
            title: t("settingsPage.notesTemplates.activationFailed"),
            description: getTemplateError(activation),
            variant: "destructive",
          });
          return;
        }
      }
      const result = await api.setDefaultNoteTemplate(templateId, template.active_revision_id);
      if (!result.success) {
        toast({
          title: t("settingsPage.notesTemplates.defaultFailed"),
          description: getTemplateError(result),
          variant: "destructive",
        });
        return;
      }
      setDefaultTemplateId(templateId);
      await loadTemplates();
    } catch (setDefaultError) {
      toast({
        title: t("settingsPage.notesTemplates.defaultFailed"),
        description: setDefaultError instanceof Error ? setDefaultError.message : String(setDefaultError),
        variant: "destructive",
      });
    } finally {
      setBusyTemplateId(null);
    }
  };

  const handleDelete = async () => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!deleteTarget || deleteTarget.is_builtin || !apiAvailable || !api?.deleteNoteTemplate) {
      if (!deleteTarget?.is_builtin) showUnavailableToast();
      return;
    }

    setDeleting(true);
    try {
      const result = await api.deleteNoteTemplate(deleteTarget.id);
      if (!result.success) {
        toast({
          title: t("settingsPage.notesTemplates.deleteFailed"),
          description: getTemplateError(result),
          variant: "destructive",
        });
        return;
      }
      setDeleteTarget(null);
      await loadTemplates();
    } catch (deleteError) {
      toast({
        title: t("settingsPage.notesTemplates.deleteFailed"),
        description: deleteError instanceof Error ? deleteError.message : String(deleteError),
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4 border-t border-border/40 pt-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold tracking-tight text-foreground">
            {t("settingsPage.notesTemplates.title")}
          </h3>
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
            {t("settingsPage.notesTemplates.description")}
          </p>
        </div>
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      </div>

      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.notesTemplates.enabled")}
            description={t("settingsPage.notesTemplates.enabledDescription")}
          >
            <Toggle checked={templatesEnabled} onChange={setTemplatesEnabled} />
          </SettingsRow>
        </SettingsPanelRow>
        <SettingsPanelRow>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">
                {t("settingsPage.notesTemplates.defaultTemplate")}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">
                {t("settingsPage.notesTemplates.defaultTemplateDescription")}
              </p>
            </div>
            <select
              aria-label={t("settingsPage.notesTemplates.defaultTemplate")}
              value={defaultTemplateId ?? ""}
              onChange={(event) => void handleSetDefault(Number(event.target.value))}
              disabled={loading || !apiAvailable || templates.length === 0 || busyTemplateId !== null}
              className="h-8 min-w-48 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm outline-none transition-colors hover:border-border-hover focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>
                {t("settingsPage.notesTemplates.selectTemplate")}
              </option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold text-foreground">
              {t("settingsPage.notesTemplates.listTitle")}
            </h4>
            <p className="mt-0.5 text-xs text-muted-foreground/80">
              {t("settingsPage.notesTemplates.listDescription")}
            </p>
          </div>
          <Button size="sm" onClick={openCreate} disabled={!apiAvailable}>
            <Plus className="h-3.5 w-3.5" />
            {t("settingsPage.notesTemplates.add")}
          </Button>
        </div>

        {!apiAvailable && (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            {t("settingsPage.notesTemplates.unavailableDescription")}
          </div>
        )}

        {apiAvailable && loading && (
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-4 py-6 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("settingsPage.notesTemplates.loading")}
          </div>
        )}

        {apiAvailable && !loading && error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs leading-relaxed text-destructive">
            {t("settingsPage.notesTemplates.loadFailed")}: {error}
          </div>
        )}

        {apiAvailable && !loading && !error && templates.length === 0 && (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            {t("settingsPage.notesTemplates.empty")}
          </div>
        )}

        {apiAvailable && !loading && templates.length > 0 && (
          <SettingsPanel className="overflow-hidden">
            {templates.map((template) => {
              const isDefault = template.id === defaultTemplate?.id || template.is_default;
              const isActive = template.active_revision_id !== null;
              const isBusy = busyTemplateId === template.id;
              return (
                <SettingsPanelRow key={template.id} className="transition-colors hover:bg-foreground/3 dark:hover:bg-white/3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="text-xs font-semibold text-foreground">{template.name}</p>
                        {isActive && (
                          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            <Check className="h-3 w-3" />
                            {t("settingsPage.notesTemplates.active")}
                          </span>
                        )}
                        {isDefault && (
                          <span className="rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                            {t("settingsPage.notesTemplates.default")}
                          </span>
                        )}
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {template.is_builtin
                            ? t("settingsPage.notesTemplates.builtIn")
                            : t("settingsPage.notesTemplates.custom")}
                        </span>
                      </div>
                      {template.description && (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                          {template.description}
                        </p>
                      )}
                      <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                        {t("settingsPage.notesTemplates.revision", {
                          version: template.active_revision?.version ?? template.revisions[0]?.version ?? 1,
                        })}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!isDefault && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleSetDefault(template.id)}
                          disabled={isBusy || busyTemplateId !== null}
                        >
                          {isBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          {t("settingsPage.notesTemplates.makeDefault")}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => openEdit(template)}>
                        <Pencil className="h-3.5 w-3.5" />
                        {t("settingsPage.notesTemplates.edit")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openDuplicate(template)}>
                        <CopyPlus className="h-3.5 w-3.5" />
                        {t("settingsPage.notesTemplates.duplicate")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteTarget(template)}
                        disabled={template.is_builtin}
                        title={
                          template.is_builtin
                            ? t("settingsPage.notesTemplates.builtInDeleteDisabled")
                            : undefined
                        }
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("settingsPage.notesTemplates.delete")}
                      </Button>
                    </div>
                  </div>
                </SettingsPanelRow>
              );
            })}
          </SettingsPanel>
        )}
      </div>

      <NotesTemplatesEditor
        open={editorOpen}
        mode={editorMode}
        template={editorTemplate}
        initialValues={editorValues}
        saving={saving}
        onOpenChange={setEditorOpen}
        onSave={handleSave}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        title={t("settingsPage.notesTemplates.confirmDeleteTitle")}
        description={t("settingsPage.notesTemplates.confirmDeleteDescription", {
          name: deleteTarget?.name ?? "",
        })}
        confirmText={t("settingsPage.notesTemplates.deleteConfirm")}
        cancelText={t("settingsPage.notesTemplates.cancel")}
        variant="destructive"
        onConfirm={() => void handleDelete()}
        confirmDisabled={deleting}
      />
    </div>
  );
}
