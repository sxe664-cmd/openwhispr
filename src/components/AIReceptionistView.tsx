import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import AIReceptionistStatus from "./ai-receptionist/AIReceptionistStatus";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "./lib/utils";

type Config = Record<string, unknown>;
type SaveState = "idle" | "saving" | "saved" | "error";
type GoogleState =
  "checking" | "ready" | "setup_required" | "authorization_required" | "unavailable" | "error";

interface ReceptionistDraft {
  enabled: boolean;
  name: string;
  greeting: string;
  afterHoursMessage: string;
  description: string;
  transferNumber: string;
  services: string;
  faqs: string;
  escalation: string;
  prohibitedClaims: string;
  hours: string;
  routing: string;
  idleTimeout: string;
  recording: boolean;
}

interface MessageDraft {
  enabled: boolean;
  emailSubject: string;
  emailTemplate: string;
  smsTemplate: string;
  hoursBefore: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
}

interface PostDraft {
  enabled: boolean;
  preset: string;
  emailSubject: string;
  emailTemplate: string;
  emailHtml: string;
  smsTemplate: string;
  daysAfter: string;
  emailEnabled: boolean;
  smsEnabled: boolean;
}

const DEFAULT_RECEPTIONIST: ReceptionistDraft = {
  enabled: false,
  name: "",
  greeting: "",
  afterHoursMessage: "",
  description: "",
  transferNumber: "",
  services: "",
  faqs: "",
  escalation: "",
  prohibitedClaims: "",
  hours: "",
  routing: "",
  idleTimeout: "30",
  recording: false,
};
const DEFAULT_MESSAGE: MessageDraft = {
  enabled: false,
  emailSubject: "",
  emailTemplate: "",
  smsTemplate: "",
  hoursBefore: "1",
  emailEnabled: true,
  smsEnabled: false,
};
const DEFAULT_POST: PostDraft = {
  enabled: false,
  preset: "thank_you_review",
  emailSubject: "",
  emailTemplate: "",
  emailHtml: "",
  smsTemplate: "",
  daysAfter: "1",
  emailEnabled: true,
  smsEnabled: false,
};
const VARIABLES = [
  "{business_name}",
  "{recipient_name}",
  "{appointment_time}",
  "{offset_days}",
  "{default_transfer_number}",
  "{appointment_start}",
  "{appointment_end}",
  "{appointment_link}",
];
const TEMPLATE_GROUPS: ReadonlyArray<{ title: string; fields: ReadonlyArray<readonly [string, string]> }> = [
  {
    title: "Confirmation",
    fields: [
      ["confirmation_email_subject", "Email subject"],
      ["confirmation_email_text", "Email body"],
      ["confirmation_sms", "SMS"],
    ],
  },
  {
    title: "Quick text actions",
    fields: [
      ["quick_sms", "General SMS"],
      ["quick_email", "General email"],
      ["quick_call_script", "Call script"],
    ],
  },
  {
    title: "Post-appointment reminder",
    fields: [
      ["post_reminder_email_subject", "Email subject"],
      ["post_reminder_email_text", "Email body"],
      ["post_reminder_email_html", "Email body (HTML)"],
      ["post_reminder_sms", "SMS"],
    ],
  },
  {
    title: "Message notification email",
    fields: [
      ["message_email_subject", "Email subject"],
      ["message_email_text", "Email body"],
      ["message_email_html", "Email body (HTML)"],
    ],
  },
  {
    title: "Call summary email",
    fields: [
      ["call_end_email_subject", "Email subject"],
      ["call_end_email_text", "Email body"],
      ["call_end_email_html", "Email body (HTML)"],
    ],
  },
  {
    title: "Booking notification email",
    fields: [
      ["booking_email_subject", "Email subject"],
      ["booking_email_text", "Email body"],
      ["booking_email_html", "Email body (HTML)"],
    ],
  },
] as const;

function value(config: Config | null, keys: string[], fallback: string) {
  for (const key of keys) if (typeof config?.[key] === "string") return config[key] as string;
  return fallback;
}

function booleanValue(config: Config | null, keys: string[], fallback: boolean) {
  for (const key of keys) if (typeof config?.[key] === "boolean") return config[key] as boolean;
  return fallback;
}

function numberValue(config: Config | null, keys: string[], fallback: string) {
  for (const key of keys) if (typeof config?.[key] === "number") return String(config[key]);
  return fallback;
}

function firstNumber(config: Config | null, keys: string[], fallback: string) {
  for (const key of keys) {
    const candidate = config?.[key];
    if (Array.isArray(candidate) && typeof candidate[0] === "number") return String(candidate[0]);
  }
  return numberValue(config, keys, fallback);
}

function textValue(config: Config | null, keys: string[], fallback: string) {
  for (const key of keys) {
    const candidate = config?.[key];
    if (Array.isArray(candidate))
      return candidate
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join("\n");
  }
  return value(config, keys, fallback);
}

function structuredValue(config: Config | null, keys: string[], fallback: string) {
  for (const key of keys) {
    const candidate = config?.[key];
    if (candidate && typeof candidate === "object") return JSON.stringify(candidate, null, 2);
  }
  return value(config, keys, fallback);
}

function readReceptionist(config: Config | null): ReceptionistDraft {
  return {
    enabled: booleanValue(config, ["enabled", "active"], DEFAULT_RECEPTIONIST.enabled),
    name: value(config, ["name", "assistant_name", "receptionist_name"], ""),
    greeting: value(config, ["greeting", "opening_greeting"], ""),
    afterHoursMessage: value(config, ["after_hours_message"], ""),
    description: value(config, ["description"], ""),
    transferNumber: value(config, ["default_transfer_number"], ""),
    services: textValue(config, ["services", "service_catalog"], ""),
    faqs: textValue(config, ["faqs", "frequently_asked_questions"], ""),
    escalation: value(config, ["escalation", "escalation_instructions"], ""),
    prohibitedClaims: textValue(config, ["prohibited_claims", "prohibitedClaims"], ""),
    hours: structuredValue(config, ["hours", "business_hours"], ""),
    routing: textValue(config, ["routing", "call_routing"], ""),
    idleTimeout: numberValue(
      config,
      ["idle_timeout_seconds", "idle_timeout"],
      DEFAULT_RECEPTIONIST.idleTimeout
    ),
    recording: booleanValue(
      config,
      ["recording_enabled", "record_calls"],
      DEFAULT_RECEPTIONIST.recording
    ),
  };
}

function readMessage(config: Config | null): MessageDraft {
  const templates = (config?.templates as Config | undefined) || config;
  const reminders = (config?.reminders as Config | undefined) || {};
  return {
    enabled: booleanValue(
      reminders,
      ["enabled", "pre_appointment_enabled"],
      DEFAULT_MESSAGE.enabled
    ),
    emailSubject: value(templates, ["reminder_email_subject"], ""),
    emailTemplate: value(templates, ["reminder_email_text", "email_template", "email"], ""),
    smsTemplate: value(templates, ["reminder_sms", "sms_template", "sms"], ""),
    hoursBefore: firstNumber(
      reminders,
      ["offset_days", "timing_days"],
      DEFAULT_MESSAGE.hoursBefore
    ),
    emailEnabled: Array.isArray(reminders.channels)
      ? reminders.channels.includes("email")
      : DEFAULT_MESSAGE.emailEnabled,
    smsEnabled: Array.isArray(reminders.channels)
      ? reminders.channels.includes("sms")
      : DEFAULT_MESSAGE.smsEnabled,
  };
}

function readPost(config: Config | null): PostDraft {
  const templates = (config?.templates as Config | undefined) || {};
  const preset = value(config, ["preset"], DEFAULT_POST.preset);
  const presetConfig = (templates[preset] as Config | undefined) || {};
  const followUps = Array.isArray(config?.follow_ups) ? (config.follow_ups as Config[]) : [];
  const selectedFollowUp = followUps.find((item) => item.preset === preset) || {};
  const channels = Array.isArray(selectedFollowUp.channels) ? selectedFollowUp.channels : [];
  return {
    enabled: booleanValue(config, ["enabled", "post_appointment_enabled"], DEFAULT_POST.enabled),
    preset,
    emailSubject: value(presetConfig, ["email_subject"], ""),
    emailTemplate: value(presetConfig, ["email_text", "email_template", "email"], ""),
    emailHtml: value(presetConfig, ["email_html"], ""),
    smsTemplate: value(presetConfig, ["sms", "sms_template"], ""),
    daysAfter: numberValue(
      selectedFollowUp,
      ["offset_days_after"],
      numberValue(config, ["offset_days_after"], DEFAULT_POST.daysAfter)
    ),
    emailEnabled: channels.length > 0 ? channels.includes("email") : DEFAULT_POST.emailEnabled,
    smsEnabled: channels.length > 0 ? channels.includes("sms") : DEFAULT_POST.smsEnabled,
  };
}

function readLibraryTemplates(config: Config | null): Record<string, string> {
  const templates = (config?.templates as Config | undefined) || {};
  return Object.fromEntries(
    TEMPLATE_GROUPS.flatMap((group) => group.fields).map(([key]) => [
      key,
      typeof templates[key] === "string" ? templates[key] : "",
    ])
  );
}

function withLines(valueText: string) {
  return valueText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
function preview(text: string) {
  return text
    .replace(/\{business_name\}/g, "Your practice")
    .replace(/\{recipient_name\}/g, "Alex Morgan")
    .replace(/\{appointment_time\}/g, "Tuesday, June 18 at 10:30 AM")
    .replace(/\{offset_days\}/g, "1")
    .replace(/\{default_transfer_number\}/g, "+1 555 0100")
    .replace(/\{appointment_start\}/g, "Tuesday, June 18 at 10:30 AM")
    .replace(/\{appointment_end\}/g, "Tuesday, June 18 at 11:00 AM")
    .replace(/\{appointment_link\}/g, "your calendar link");
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {description && (
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      )}
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-primary"
      />
      {label}
    </label>
  );
}

function EditorCard({
  title,
  description,
  children,
  onSave,
  saveState,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onSave: () => void;
  saveState: SaveState;
}) {
  return (
    <section className="ai-receptionist-editor-card rounded-xl border border-border/60 bg-card/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={onSave}
          disabled={saveState === "saving"}
        >
          <Save size={13} />
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
        </Button>
      </div>
      <div className="mt-4">{children}</div>
      {saveState === "error" && (
        <p className="mt-3 text-xs text-destructive">
          Could not save this configuration. Your previous saved configuration is unchanged.
        </p>
      )}
      {saveState === "saved" && (
        <p className="mt-3 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check size={13} />
          Saved and reloaded from the runtime.
        </p>
      )}
    </section>
  );
}

export default function AIReceptionistView({ embedded = false }: { embedded?: boolean }) {
  const [googleState, setGoogleState] = useState<GoogleState>("checking");
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [receptionistConfig, setReceptionistConfig] = useState<Config | null>(null);
  const [messageConfig, setMessageConfig] = useState<Config | null>(null);
  const [postConfig, setPostConfig] = useState<Config | null>(null);
  const [emailConfig, setEmailConfig] = useState<Config | null>(null);
  const [receptionist, setReceptionist] = useState(DEFAULT_RECEPTIONIST);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [post, setPost] = useState(DEFAULT_POST);
  const [libraryTemplates, setLibraryTemplates] = useState<Record<string, string>>({});
  const [emailProvider, setEmailProvider] = useState("smtp");
  const [emailFromName, setEmailFromName] = useState("");
  const [emailFromAddress, setEmailFromAddress] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  const loadAll = useCallback(async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const api = window.electronAPI;
      const [receptionistResult, messageResult, postResult, emailResult] = await Promise.all([
        api?.getReceptionistConfig?.(),
        api?.getMessageConfig?.(),
        api?.getPostAppointmentWorkspace?.(),
        api?.getEmailSetup?.(),
      ]);
      if (!receptionistResult?.success || !messageResult?.success || !postResult?.success)
        throw new Error("AI_RECEPTIONIST_CONFIG_UNAVAILABLE");
      setReceptionistConfig(receptionistResult.config);
      setMessageConfig(messageResult.config);
      setPostConfig(postResult.config);
      setEmailConfig(emailResult?.config || null);
      setReceptionist(readReceptionist(receptionistResult.config));
      setMessage(readMessage(messageResult.config));
      setPost(readPost(postResult.config));
      setLibraryTemplates(readLibraryTemplates(messageResult.config));
      setEmailProvider(
        value(emailResult?.config || null, ["sender_type", "provider", "transport"], "smtp")
      );
      setEmailFromName(value(emailResult?.config || null, ["from_name", "sender_name"], ""));
      setEmailFromAddress(
        value(emailResult?.config || null, ["from", "from_email", "sender_email"], "")
      );
      setLoadState("ready");
    } catch {
      setLoadState("error");
      setLoadError(
        "AI Receptionist settings could not be loaded. Try reload when the private runtime is available."
      );
    }
  }, []);

  const loadGoogle = useCallback(async () => {
    try {
      const status = await window.electronAPI?.gcalGetCalendarStatus?.();
      setGoogleEmail(status?.email || null);
      setGoogleError(status?.error?.message || null);
      const state = status?.state;
      setGoogleState(
        state === "ready"
          ? "ready"
          : state === "setup_required"
            ? "setup_required"
            : state === "authorization_required"
              ? "authorization_required"
              : state === "unavailable"
                ? "unavailable"
                : "error"
      );
    } catch {
      setGoogleState("error");
      setGoogleError(null);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    void loadGoogle();
  }, [loadAll, loadGoogle]);

  const save = useCallback(
    async (
      key: string,
      method:
        | ((
            config: Config
          ) => Promise<{ success: boolean; config: Config | null; requiresRestart?: boolean }>)
        | undefined,
      config: Config
    ) => {
      if (!method) return;
      setSaveStates((current) => ({ ...current, [key]: "saving" }));
      try {
        const result = await method(config);
        if (!result?.success) throw new Error("save failed");
        setSaveStates((current) => ({ ...current, [key]: "saved" }));
        await loadAll();
      } catch {
        setSaveStates((current) => ({ ...current, [key]: "error" }));
      }
    },
    [loadAll]
  );

  const saveReceptionist = () =>
    void save("receptionist", window.electronAPI?.saveReceptionistConfig, {
      ...(receptionistConfig || {}),
      name: receptionist.name,
      greeting: receptionist.greeting,
      after_hours_message: receptionist.afterHoursMessage,
      description: receptionist.description,
      default_transfer_number: receptionist.transferNumber,
      services: withLines(receptionist.services),
      faqs: withLines(receptionist.faqs),
      escalation_rules: withLines(receptionist.escalation),
      prohibited_claims: withLines(receptionist.prohibitedClaims),
      hours: receptionist.hours,
      routing: receptionist.routing,
      idle_timeout_seconds: Math.max(5, Math.min(600, Number(receptionist.idleTimeout) || 30)),
      recording_enabled: receptionist.recording,
    });
  const saveMessage = () =>
    void save("message", window.electronAPI?.saveMessageConfig, {
      ...(messageConfig || {}),
      templates: {
        ...((messageConfig?.templates as Config | undefined) || {}),
        ...libraryTemplates,
        reminder_email_subject: message.emailSubject,
        reminder_email_text: message.emailTemplate,
        reminder_sms: message.smsTemplate,
      },
      reminders: {
        ...((messageConfig?.reminders as Config | undefined) || {}),
        enabled: message.enabled,
        channels: [
          ...(message.emailEnabled ? ["email"] : []),
          ...(message.smsEnabled ? ["sms"] : []),
        ],
        offset_days: [Math.max(1, Math.min(30, Number(message.hoursBefore) || 1))],
      },
    });
  const savePost = () => {
    const existingTemplates = (postConfig?.all_templates as Config | undefined) || {};
    const existingFollowups = (existingTemplates.post_followups as Config | undefined) || {};
    return void save("post", window.electronAPI?.savePostAppointmentConfig, {
      ...(postConfig || {}),
      enabled: post.enabled,
      offset_days_after: Math.max(1, Math.min(365, Number(post.daysAfter) || 1)),
      follow_ups: [
        ...(
          (Array.isArray(postConfig?.follow_ups) ? postConfig.follow_ups : []) as Config[]
        ).filter((item) => item.preset !== post.preset),
        {
          preset: post.preset,
          enabled: post.enabled,
          offset_days_after: Math.max(1, Math.min(365, Number(post.daysAfter) || 1)),
          channels: [...(post.emailEnabled ? ["email"] : []), ...(post.smsEnabled ? ["sms"] : [])],
        },
      ],
      templates: {
        ...existingTemplates,
        post_followups: {
          ...existingFollowups,
          [post.preset]: {
            email_subject: post.emailSubject,
            email_text: post.emailTemplate,
            email_html: post.emailHtml,
            sms: post.smsTemplate,
          },
        },
      },
    });
  };
  const saveEmail = () =>
    void save("email", window.electronAPI?.saveEmailSetup, {
      ...(emailConfig || {}),
      from: emailFromAddress,
    });

  const connectGoogle = async () => {
    setGoogleState("checking");
    const result = await window.electronAPI?.gcalConnectGoogle?.();
    if (!result?.success)
      setGoogleError(result?.error?.message || "Google Calendar setup could not be started.");
    await loadGoogle();
  };
  const insertVariable = (variable: string, kind: "email" | "sms") =>
    setMessage((current) => ({
      ...current,
      [kind === "email" ? "emailTemplate" : "smsTemplate"]:
        `${current[kind === "email" ? "emailTemplate" : "smsTemplate"]}${variable}`,
    }));
  const insertPostVariable = (variable: string, kind: "email" | "sms") =>
    setPost((current) => ({
      ...current,
      [kind === "email" ? "emailTemplate" : "smsTemplate"]:
        `${current[kind === "email" ? "emailTemplate" : "smsTemplate"]}${variable}`,
    }));
  const selectPostPreset = (preset: string) => setPost(readPost({ ...(postConfig || {}), preset }));
  const prePreview = useMemo(
    () => preview(message.emailTemplate || message.smsTemplate),
    [message.emailTemplate, message.smsTemplate]
  );
  const postPreview = useMemo(
    () => preview(post.emailTemplate || post.smsTemplate),
    [post.emailTemplate, post.smsTemplate]
  );

  return (
    <section
      className={cn("ai-receptionist-view space-y-5", embedded ? "" : "mx-auto max-w-5xl px-5 py-6")}
      aria-labelledby="ai-receptionist-title"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <h1 id="ai-receptionist-title" className="text-lg font-semibold tracking-tight">
              AI Receptionist
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the private receptionist, appointment messaging, and follow-up automation.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void loadAll();
            void loadGoogle();
          }}
          disabled={loadState === "loading"}
        >
          <RefreshCw size={14} className={cn(loadState === "loading" && "animate-spin")} />
          Reload
        </Button>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        <AIReceptionistStatus />
        <section className="ai-receptionist-status-panel rounded-xl border border-border/60 bg-card/50 p-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "mt-0.5",
                googleState === "ready"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : googleState === "checking"
                    ? "text-primary"
                    : "text-amber-600 dark:text-amber-400"
              )}
            >
              {googleState === "checking" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : googleState === "ready" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <CircleAlert className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Google Calendar</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {googleState === "ready"
                  ? googleEmail
                    ? `Connected as ${googleEmail}`
                    : "Connected and managed by AIReceptionist."
                  : googleState === "setup_required"
                    ? "Setup is required before calendar browsing can start."
                    : googleState === "authorization_required"
                      ? "Authorization is required to read appointments."
                      : googleState === "unavailable"
                        ? "The managed runtime is not available in this build."
                        : "Google Calendar connection needs attention."}
              </p>
              {googleError && <p className="mt-1 text-xs text-destructive">{googleError}</p>}
              {(googleState === "setup_required" || googleState === "authorization_required") && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 h-8 text-xs"
                  onClick={() => void connectGoogle()}
                >
                  <ExternalLink size={13} />
                  {googleState === "setup_required" ? "Start setup" : "Reconnect Google"}
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
      {loadState === "loading" && (
        <div className="ai-receptionist-runtime-panel flex items-center gap-2 rounded-xl border border-border/60 bg-card/50 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 size={15} className="animate-spin text-primary" />
          Loading settings from the private runtime…
        </div>
      )}
      {loadState === "error" && (
        <div className="ai-receptionist-runtime-panel ai-receptionist-runtime-panel--error flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <CircleAlert size={14} />
          {loadError}
        </div>
      )}
      {loadState === "ready" && (
        <>
          <EditorCard
            title="Receptionist settings"
            description="These values are validated and persisted by the AIReceptionist runtime."
            onSave={saveReceptionist}
            saveState={saveStates.receptionist || "idle"}
          >
            <div className="space-y-4">
              <Toggle
                checked={receptionist.enabled}
                onChange={(enabled) => setReceptionist((current) => ({ ...current, enabled }))}
                label={receptionist.enabled ? "Receptionist enabled" : "Receptionist disabled"}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="After-hours message">
                  <textarea
                    className="min-h-20 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.afterHoursMessage}
                    onChange={(event) =>
                      setReceptionist((current) => ({
                        ...current,
                        afterHoursMessage: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Receptionist description">
                  <textarea
                    className="min-h-20 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.description}
                    onChange={(event) =>
                      setReceptionist((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Receptionist name">
                  <Input
                    value={receptionist.name}
                    onChange={(event) =>
                      setReceptionist((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Front desk"
                  />
                </Field>
                <Field label="Transfer number">
                  <Input
                    value={receptionist.transferNumber}
                    onChange={(event) =>
                      setReceptionist((current) => ({
                        ...current,
                        transferNumber: event.target.value,
                      }))
                    }
                    placeholder="+1 555 0100"
                  />
                </Field>
                <Field label="Idle timeout (seconds)" description="Validated to 5–600 seconds.">
                  <Input
                    type="number"
                    min={5}
                    max={600}
                    value={receptionist.idleTimeout}
                    onChange={(event) =>
                      setReceptionist((current) => ({
                        ...current,
                        idleTimeout: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field label="Greeting">
                <textarea
                  className="min-h-20 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  value={receptionist.greeting}
                  onChange={(event) =>
                    setReceptionist((current) => ({ ...current, greeting: event.target.value }))
                  }
                />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Services" description="One service per line.">
                  <textarea
                    className="min-h-24 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.services}
                    onChange={(event) =>
                      setReceptionist((current) => ({ ...current, services: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label="FAQs"
                  description="One JSON object per line with question and answer."
                >
                  <textarea
                    className="min-h-24 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.faqs}
                    onChange={(event) =>
                      setReceptionist((current) => ({ ...current, faqs: event.target.value }))
                    }
                  />
                </Field>
                <Field label="Escalation instructions">
                  <textarea
                    className="min-h-20 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.escalation}
                    onChange={(event) =>
                      setReceptionist((current) => ({ ...current, escalation: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label="Prohibited claims"
                  description="One claim per line; the runtime rejects unsafe values."
                >
                  <textarea
                    className="min-h-20 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.prohibitedClaims}
                    onChange={(event) =>
                      setReceptionist((current) => ({
                        ...current,
                        prohibitedClaims: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Business hours" description="Edit the validated JSON object.">
                  <textarea
                    className="min-h-24 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.hours}
                    onChange={(event) =>
                      setReceptionist((current) => ({ ...current, hours: event.target.value }))
                    }
                  />
                </Field>
                <Field label="Call routing" description="One JSON object per line.">
                  <textarea
                    className="min-h-24 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    value={receptionist.routing}
                    onChange={(event) =>
                      setReceptionist((current) => ({ ...current, routing: event.target.value }))
                    }
                  />
                </Field>
              </div>
              <Toggle
                checked={receptionist.recording}
                onChange={(recording) => setReceptionist((current) => ({ ...current, recording }))}
                label="Record receptionist calls when permitted"
              />
            </div>
          </EditorCard>
          <EditorCard
            title="Pre-appointment reminders"
            description="Automatically send validated email and SMS reminders through the configured channels."
            onSave={saveMessage}
            saveState={saveStates.message || "idle"}
          >
            <div className="space-y-4">
              <Toggle
                checked={message.enabled}
                onChange={(enabled) => setMessage((current) => ({ ...current, enabled }))}
                label={
                  message.enabled
                    ? "Pre-appointment reminders enabled"
                  : "Pre-appointment reminders disabled"
                }
              />
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                When enabled, the private runtime schedules reminders from synced calendar events
                and sends them automatically at the selected lead time. Delivery still requires a
                configured provider and a valid recipient for the selected channel.
              </p>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Send before (days)">
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    value={message.hoursBefore}
                    onChange={(event) =>
                      setMessage((current) => ({ ...current, hoursBefore: event.target.value }))
                    }
                  />
                </Field>
                <div className="flex items-end gap-4 pb-2">
                  <Toggle
                    checked={message.emailEnabled}
                    onChange={(emailEnabled) =>
                      setMessage((current) => ({ ...current, emailEnabled }))
                    }
                    label="Email"
                  />
                  <Toggle
                    checked={message.smsEnabled}
                    onChange={(smsEnabled) => setMessage((current) => ({ ...current, smsEnabled }))}
                    label="SMS"
                  />
                </div>
              </div>
              <Field label="Email subject">
                <Input
                  value={message.emailSubject}
                  onChange={(event) =>
                    setMessage((current) => ({ ...current, emailSubject: event.target.value }))
                  }
                />
              </Field>
              <TemplateEditor
                label="Email template"
                value={message.emailTemplate}
                onChange={(emailTemplate) =>
                  setMessage((current) => ({ ...current, emailTemplate }))
                }
                onInsert={(variable) => insertVariable(variable, "email")}
              />
              <TemplateEditor
                label="SMS template"
                value={message.smsTemplate}
                onChange={(smsTemplate) => setMessage((current) => ({ ...current, smsTemplate }))}
                onInsert={(variable) => insertVariable(variable, "sms")}
              />
              <Preview text={prePreview} icon={<Clock3 size={13} />} />
            </div>
          </EditorCard>
          <EditorCard
            title="Message library"
            description="The same confirmation, quick-action, notification, call-summary, and booking templates used by AIReceptionist."
            onSave={saveMessage}
            saveState={saveStates.message || "idle"}
          >
            <div className="space-y-3">
              {TEMPLATE_GROUPS.map((group) => (
                <details
                  key={group.title}
                  className="ai-receptionist-template-group rounded-lg border border-border/50 bg-muted/15 p-3"
                >
                  <summary className="cursor-pointer text-xs font-semibold">{group.title}</summary>
                  <div className="mt-4 space-y-4">
                    {group.fields.map(([key, label]) => (
                      <TemplateEditor
                        key={key}
                        label={label}
                        value={libraryTemplates[key] || ""}
                        onChange={(next) =>
                          setLibraryTemplates((current) => ({ ...current, [key]: next }))
                        }
                        onInsert={(variable) =>
                          setLibraryTemplates((current) => ({
                            ...current,
                            [key]: `${current[key] || ""}${variable}`,
                          }))
                        }
                      />
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </EditorCard>
          <EditorCard
            title="Post-appointment follow-up"
            description="Follow up relative to appointment end; timing is bounded to 1–365 days by the runtime."
            onSave={savePost}
            saveState={saveStates.post || "idle"}
          >
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                <Toggle
                  checked={post.enabled}
                  onChange={(enabled) => setPost((current) => ({ ...current, enabled }))}
                  label={post.enabled ? "Follow-up enabled" : "Follow-up disabled"}
                />
                <label className="flex items-center gap-2 text-xs">
                  <span className="font-medium">Preset</span>
                  <select
                    className="ai-receptionist-control h-9 rounded border border-border/70 bg-input px-2 text-xs"
                    value={post.preset}
                    onChange={(event) => selectPostPreset(event.target.value)}
                  >
                    <option value="thank_you_review">Thank you + review</option>
                    <option value="thank_you_only">Thank you only</option>
                    <option value="book_next_appointment">Book next appointment</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <span className="font-medium">Days after</span>
                  <Input
                    className="h-9 w-20"
                    type="number"
                    min={1}
                    max={365}
                    value={post.daysAfter}
                    onChange={(event) =>
                      setPost((current) => ({ ...current, daysAfter: event.target.value }))
                    }
                  />
                </label>
              </div>
              <div className="flex items-center gap-4">
                <Toggle
                  checked={post.emailEnabled}
                  onChange={(emailEnabled) => setPost((current) => ({ ...current, emailEnabled }))}
                  label="Email"
                />
                <Toggle
                  checked={post.smsEnabled}
                  onChange={(smsEnabled) => setPost((current) => ({ ...current, smsEnabled }))}
                  label="SMS"
                />
              </div>
              <Field label="Email subject">
                <Input
                  value={post.emailSubject}
                  onChange={(event) =>
                    setPost((current) => ({ ...current, emailSubject: event.target.value }))
                  }
                />
              </Field>
              <TemplateEditor
                label="Email template"
                value={post.emailTemplate}
                onChange={(emailTemplate) => setPost((current) => ({ ...current, emailTemplate }))}
                onInsert={(variable) => insertPostVariable(variable, "email")}
              />
              <TemplateEditor
                label="Email body (HTML, optional)"
                value={post.emailHtml}
                onChange={(emailHtml) => setPost((current) => ({ ...current, emailHtml }))}
                onInsert={(variable) =>
                  setPost((current) => ({
                    ...current,
                    emailHtml: `${current.emailHtml}${variable}`,
                  }))
                }
              />
              <TemplateEditor
                label="SMS template"
                value={post.smsTemplate}
                onChange={(smsTemplate) => setPost((current) => ({ ...current, smsTemplate }))}
                onInsert={(variable) => insertPostVariable(variable, "sms")}
              />
              <Preview text={postPreview} icon={<Sparkles size={13} />} />
            </div>
          </EditorCard>
          <EditorCard
            title="Email provider"
            description="Only non-secret sender settings are editable here; credentials remain in the private runtime."
            onSave={saveEmail}
            saveState={saveStates.email || "idle"}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Provider">
                <select
                  className="ai-receptionist-control h-10 w-full rounded border border-border/70 bg-input px-3 text-sm"
                  value={emailProvider}
                  onChange={(event) => setEmailProvider(event.target.value)}
                >
                  <option value="smtp">SMTP</option>
                  <option value="sendgrid">SendGrid</option>
                  <option value="ses">Amazon SES</option>
                  <option value="none">Not configured</option>
                </select>
              </Field>
              <Field label="From name">
                <Input
                  value={emailFromName}
                  onChange={(event) => setEmailFromName(event.target.value)}
                />
              </Field>
              <Field label="From email">
                <Input
                  type="email"
                  value={emailFromAddress}
                  onChange={(event) => setEmailFromAddress(event.target.value)}
                />
              </Field>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck size={13} className="text-primary" />
              Provider credentials are never returned to React or displayed here.
            </p>
          </EditorCard>
        </>
      )}
    </section>
  );
}

function TemplateEditor({
  label,
  value,
  onChange,
  onInsert,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onInsert: (variable: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        <div className="flex flex-wrap justify-end gap-1">
          {VARIABLES.map((variable) => (
            <button
              type="button"
              key={variable}
              className="ai-receptionist-variable-chip rounded bg-muted px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => onInsert(variable)}
            >
              {variable}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className="ai-receptionist-message-field mt-2 min-h-24 w-full rounded-xl border border-border/70 bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Preview({ text, icon }: { text: string; icon: ReactNode }) {
  return (
    <div className="ai-receptionist-preview rounded-lg border border-border/50 bg-muted/25 p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}Preview
      </p>
      <p className="mt-2 whitespace-pre-wrap text-xs text-foreground">
        {text || "Enter a template to preview the rendered message."}
      </p>
    </div>
  );
}
