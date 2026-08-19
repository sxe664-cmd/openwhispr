import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  FolderOpen,
  Loader2,
  Mail,
  Phone,
  Save,
  Search,
  UserRoundPlus,
  UsersRound,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "./lib/utils";
import type {
  PatientRegistryPayload,
  PatientEncounterHistoryItem,
  PatientRegistryRecord,
  PatientSmsConsentStatus,
} from "../types/patientRegistry";

type PatientForm = {
  patient_id?: string;
  name: string;
  dob: string;
  email: string;
  phone: string;
  sms_consent_status: PatientSmsConsentStatus;
};

const EMPTY_FORM: PatientForm = {
  name: "",
  dob: "",
  email: "",
  phone: "",
  sms_consent_status: "opted_in",
};

function formFromPatient(patient: PatientRegistryRecord): PatientForm {
  return {
    patient_id: patient.patient_id,
    name: patient.name,
    dob: patient.dob,
    email: patient.email || "",
    phone: patient.phone || "",
    sms_consent_status: patient.sms_consent_status === "opted_out" ? "opted_out" : "opted_in",
  };
}

function contactSummary(patient: PatientRegistryRecord) {
  return [patient.email, patient.phone].filter(Boolean).join(" · ") || "No contact details yet";
}

interface PatientRegistryViewProps {
  onOpenFolder?: (folderId: number) => void;
  onOpenEncounter?: (folderId: number, noteId: number) => void;
}

export default function PatientRegistryView({ onOpenFolder, onOpenEncounter }: PatientRegistryViewProps) {
  const [patients, setPatients] = useState<PatientRegistryRecord[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<PatientForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<PatientEncounterHistoryItem[]>([]);
  const [mergeCandidates, setMergeCandidates] = useState<PatientRegistryRecord[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [mergePhone, setMergePhone] = useState<string | null>(null);
  const [mergeEmail, setMergeEmail] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSaving, setMergeSaving] = useState(false);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.patient_id === selectedId) || null,
    [patients, selectedId]
  );

  const loadPatients = useCallback(async (search: string) => {
    const list = window.electronAPI?.listPatientRegistry;
    if (!list) {
      setLoading(false);
      setError("Patient registry is unavailable in this build.");
      return;
    }
    setLoading(true);
    try {
      const result = await list(search);
      if (!result.success) throw new Error(result.error?.message || "Patient registry is unavailable.");
      setPatients(result.patients || []);
      setError(null);
      setSelectedId((current) => {
        if (current && result.patients.some((patient) => patient.patient_id === current)) return current;
        return result.patients[0]?.patient_id || null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Patient registry is unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPatients(query), query ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [loadPatients, query]);

  useEffect(() => {
    if (selectedPatient) setForm(formFromPatient(selectedPatient));
  }, [selectedPatient]);

  useEffect(() => {
    let stale = false;
    setHistory([]);
    setMergeCandidates([]);
    setMergeOpen(false);
    setMergeError(null);
    if (!selectedId) return () => { stale = true; };
    Promise.all([
      window.electronAPI?.getPatientEncounterHistory?.(selectedId) ?? Promise.resolve({ success: true, encounters: [] }),
      window.electronAPI?.getPatientMergeCandidates?.(selectedId) ?? Promise.resolve({ success: true, patients: [] }),
    ]).then(([historyResult, candidateResult]) => {
      if (stale) return;
      setHistory(historyResult.success ? historyResult.encounters || [] : []);
      setMergeCandidates(candidateResult.success ? candidateResult.patients || [] : []);
    }).catch(() => {
      if (!stale) setHistory([]);
    });
    return () => { stale = true; };
  }, [selectedId, saved]);

  const startNewPatient = () => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setSaved(false);
    setError(null);
  };

  const selectPatient = (patient: PatientRegistryRecord) => {
    setSelectedId(patient.patient_id);
    setSaved(false);
    setError(null);
  };

  const updateField = (field: keyof PatientForm, value: string) => {
    setSaved(false);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const savePatient = async () => {
    const save = window.electronAPI?.savePatientRegistryPatient;
    if (!save) {
      setError("Patient registry is unavailable in this build.");
      return;
    }
    const payload: PatientRegistryPayload = {
      ...(form.patient_id ? { patient_id: form.patient_id } : {}),
      name: form.name,
      dob: form.dob,
      email: form.email,
      phone: form.phone,
      sms_consent_status: form.sms_consent_status,
    };
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const result = await save(payload);
      if (!result.success || !result.patient) {
        throw new Error(result.error?.message || "Patient record could not be saved.");
      }
      setSelectedId(result.patient.patient_id);
      setForm(formFromPatient(result.patient));
      setSaved(true);
      await loadPatients(query);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Patient record could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const mergeTarget = mergeCandidates[0] || null;
  const survivor = [selectedPatient, ...mergeCandidates].find((patient) => patient?.patient_id === survivorId) || selectedPatient;
  const duplicate = survivorId === selectedPatient?.patient_id ? mergeTarget : selectedPatient;
  const phoneConflict = Boolean(survivor?.phone && duplicate?.phone && survivor.phone !== duplicate.phone);
  const emailConflict = Boolean(survivor?.email && duplicate?.email && survivor.email !== duplicate.email);

  const openMerge = () => {
    const target = mergeCandidates[0];
    if (!selectedPatient || !target) return;
    setSurvivorId(selectedPatient.patient_id);
    setMergePhone(selectedPatient.phone || target.phone || null);
    setMergeEmail(selectedPatient.email || target.email || null);
    setMergeError(null);
    setMergeOpen(true);
  };

  const runMerge = async () => {
    if (!survivorId || !selectedPatient || !mergeTarget) return;
    const duplicateId = duplicate.patient_id;
    const merge = window.electronAPI?.mergePatientRegistryPatients;
    if (!merge) return;
    setMergeSaving(true);
    setMergeError(null);
    try {
      const result = await merge({
        survivorPatientId: survivorId,
        duplicatePatientId: duplicateId,
        phone: mergePhone,
        email: mergeEmail,
      });
      if (!result.success || !result.patient) {
        throw new Error(result.error?.message || "Patients could not be merged.");
      }
      setSelectedId(result.patient.patient_id);
      setMergeOpen(false);
      setSaved(true);
      await loadPatients(query);
    } catch (mergeFailure) {
      setMergeError(mergeFailure instanceof Error ? mergeFailure.message : "Patients could not be merged.");
    } finally {
      setMergeSaving(false);
    }
  };

  const formatEncounterDate = (value: string | null) => {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  };

  return (
    <section className="mx-auto max-w-6xl px-5 py-6" aria-labelledby="patient-registry-title">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <UsersRound className="h-5 w-5 text-primary" />
            <h1 id="patient-registry-title" className="text-lg font-semibold tracking-tight">Patients</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Keep contact details current so calendar reminders reach the right patient.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={startNewPatient}>
          <UserRoundPlus size={14} />Add patient
        </Button>
      </header>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
          <AlertCircle size={14} />{error}
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)]">
        <div className="min-w-0 rounded-xl border border-border/60 bg-card/50">
          <div className="border-b border-border/60 p-3">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                aria-label="Search patients"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, email, or phone"
                className="h-9 pl-9 text-xs"
              />
            </div>
            <p className="mt-2 px-1 text-[11px] text-muted-foreground">
              {loading ? "Loading patients…" : `${patients.length} patient${patients.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="max-h-[530px] overflow-y-auto">
            {loading && patients.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />Loading registry…</div>
            ) : patients.length === 0 ? (
              <div className="px-5 py-12 text-center text-xs text-muted-foreground">No patients match this search.</div>
            ) : (
              patients.map((patient) => (
                <button
                  key={patient.patient_id}
                  type="button"
                  onClick={() => selectPatient(patient)}
                  className={cn(
                    "w-full border-b border-border/50 px-4 py-3 text-left transition-colors last:border-b-0",
                    selectedId === patient.patient_id ? "bg-primary/8" : "hover:bg-muted/40"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium">{patient.name}</span>
                    {patient.has_workspace && <FolderOpen size={13} className="mt-0.5 shrink-0 text-primary/70" aria-label="Patient folder created" />}
                  </div>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">{contactSummary(patient)}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground/70">DOB {patient.dob}</p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-border/60 bg-card/50">
          <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
            <div>
              <p className="text-sm font-semibold">{form.patient_id ? "Patient details" : "New patient"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Contact fields stay local and power reminder eligibility.</p>
            </div>
            {form.patient_id && (
              <div className="flex items-center gap-2">
                {selectedPatient?.has_workspace && selectedPatient.folder_id != null && onOpenFolder && (
                  <Button variant="outline" size="sm" onClick={() => onOpenFolder(selectedPatient.folder_id!)}>
                    <FolderOpen size={14} />Open folder
                  </Button>
                )}
                {mergeCandidates.length > 0 && (
                  <Button variant="outline" size="sm" onClick={openMerge}>
                    Merge duplicate
                  </Button>
                )}
              </div>
            )}
          </div>

          {mergeOpen && mergeTarget && survivor && duplicate && (
            <div className="border-b border-border/60 bg-muted/20 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Merge patient records</p>
                  <p className="mt-1 text-xs text-muted-foreground">Choose the record to keep. Their encounter history will be combined.</p>
                </div>
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setMergeOpen(false)}>Close</button>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[selectedPatient, mergeCandidates[0]].filter(Boolean).map((patient) => (
                  <button
                    key={patient!.patient_id}
                    type="button"
                    onClick={() => {
                      setSurvivorId(patient!.patient_id);
                      const other = patient!.patient_id === selectedPatient?.patient_id ? mergeCandidates[0] : selectedPatient;
                      setMergePhone(patient!.phone || other?.phone || null);
                      setMergeEmail(patient!.email || other?.email || null);
                    }}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                      survivorId === patient!.patient_id ? "border-primary bg-primary/8" : "border-border/60 hover:bg-muted/40"
                    )}
                  >
                    <span className="font-medium">Keep {patient!.name}</span>
                    <span className="mt-1 block text-muted-foreground">{patient!.encounter_count} encounter{patient!.encounter_count === 1 ? "" : "s"}</span>
                  </button>
                ))}
              </div>
              {phoneConflict && (
                <label className="mt-3 block text-xs">
                  <span className="font-medium">Phone</span>
                  <select value={mergePhone || ""} onChange={(event) => setMergePhone(event.target.value || null)} className="mt-1 flex h-9 w-full rounded border border-border/70 bg-input px-2 text-sm">
                    {[survivor.phone, duplicate.phone].filter(Boolean).map((value) => <option key={value} value={value!}>{value}</option>)}
                  </select>
                </label>
              )}
              {emailConflict && (
                <label className="mt-3 block text-xs">
                  <span className="font-medium">Email</span>
                  <select value={mergeEmail || ""} onChange={(event) => setMergeEmail(event.target.value || null)} className="mt-1 flex h-9 w-full rounded border border-border/70 bg-input px-2 text-sm">
                    {[survivor.email, duplicate.email].filter(Boolean).map((value) => <option key={value} value={value!}>{value}</option>)}
                  </select>
                </label>
              )}
              {mergeError && <p className="mt-3 text-xs text-destructive">{mergeError}</p>}
              <div className="mt-4 flex justify-end">
                <Button size="sm" onClick={() => void runMerge()} disabled={mergeSaving || !survivorId}>
                  {mergeSaving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {mergeSaving ? "Merging…" : "Merge records"}
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium">Full name</span>
              <Input value={form.name} onChange={(event) => updateField("name", event.target.value)} placeholder="Alex Morgan" autoComplete="off" />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">Date of birth</span>
              <Input type="date" value={form.dob} onChange={(event) => updateField("dob", event.target.value)} />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">Phone</span>
              <div className="relative"><Phone size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" /><Input value={form.phone} onChange={(event) => updateField("phone", event.target.value)} placeholder="(555) 555-0100" className="pl-9" autoComplete="tel" /></div>
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium">Email</span>
              <div className="relative"><Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60" /><Input type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} placeholder="alex@example.com" className="pl-9" autoComplete="email" /></div>
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium">SMS consent</span>
              <select
                value={form.sms_consent_status}
                onChange={(event) => updateField("sms_consent_status", event.target.value)}
                className="flex h-10 w-full rounded border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/10 dark:bg-surface-1 dark:border-border-subtle/50"
              >
                <option value="opted_in">Opted in — SMS can be sent</option>
                <option value="opted_out">Opted out — SMS disabled</option>
              </select>
              <span className="block text-[11px] text-muted-foreground">Email eligibility requires a valid email. SMS is enabled by default unless this patient is opted out.</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-5 py-4">
            <div className="text-[11px] text-muted-foreground">
              {form.patient_id ? `Patient ID ${form.patient_id.slice(0, 8)}…` : "A stable ID will be created when saved."}
              {saved && <span className="ml-2 text-emerald-600 dark:text-emerald-400">Saved</span>}
            </div>
            <Button onClick={() => void savePatient()} disabled={saving || !form.name.trim() || !form.dob}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? "Saving…" : "Save patient"}
            </Button>
          </div>

          {form.patient_id && (
            <div className="border-t border-border/60 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Encounter history</p>
                  <p className="mt-1 text-xs text-muted-foreground">{history.length} linked encounter{history.length === 1 ? "" : "s"}</p>
                </div>
                {selectedPatient?.has_workspace && selectedPatient.folder_id != null && onOpenFolder && (
                  <button type="button" onClick={() => onOpenFolder(selectedPatient.folder_id!)} className="text-xs font-medium text-primary hover:underline">View folder</button>
                )}
              </div>
              {history.length > 0 && (
                <div className="mt-3 divide-y divide-border/50 rounded-lg border border-border/50">
                  {history.slice(0, 8).map((encounter) => (
                    <button
                      key={encounter.encounter_id}
                      type="button"
                      disabled={encounter.note_id == null || encounter.folder_id == null || !onOpenEncounter}
                      onClick={() => {
                        if (encounter.note_id != null && encounter.folder_id != null) onOpenEncounter?.(encounter.folder_id, encounter.note_id);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-muted/30 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className="min-w-0 truncate font-medium">{encounter.appointment_title || encounter.note_title || "Encounter"}</span>
                      <span className="shrink-0 text-muted-foreground">{formatEncounterDate(encounter.encounter_date)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
