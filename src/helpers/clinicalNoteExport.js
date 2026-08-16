const { formatTimestamp } = (() => {
  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return { formatTimestamp };
})();

const SOAP_LABELS = ["Subjective", "Objective", "Assessment", "Plan"];
const SECTION_NAMES = ["summary", "soap", "encounterDetails", "participants", "transcript"];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseSoap(value) {
  const result = {};
  const text = String(value || "").trim();
  const matches = [...text.matchAll(/^(Subjective|Objective|Assessment|Plan)[ \t]*$/gim)];
  for (let index = 0; index < SOAP_LABELS.length; index += 1) {
    const label = SOAP_LABELS[index];
    const match = matches.find((entry) => entry[1].toLowerCase() === label.toLowerCase());
    if (!match) {
      result[label.toLowerCase()] = "Not documented";
      continue;
    }
    const start = (match.index || 0) + match[0].length;
    const nextMatch = matches.find((entry) => (entry.index || 0) > (match.index || 0));
    const end = nextMatch?.index ?? text.length;
    result[label.toLowerCase()] = text.slice(start, end).trim() || "Not documented";
  }
  return result;
}

function parseParticipants(value) {
  const parsed = parseJson(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((participant) => participant?.displayName || participant?.name)
    .filter(Boolean)
    .map(String);
}

function parseSegments(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed)
    ? parsed
        .filter((segment) => segment && String(segment.text || "").trim())
        .map((segment) => ({
          speaker: segment.speaker || null,
          speakerName: segment.speakerName || null,
          speakerIsPlaceholder: segment.speakerIsPlaceholder === true,
          source: segment.source || null,
          timestamp: Number(segment.timestamp) || 0,
          text: String(segment.text).trim(),
        }))
    : [];
}

function speakerName(segment, mappings) {
  if (segment.speakerName && !segment.speakerIsPlaceholder) return segment.speakerName;
  if (segment.speaker && mappings?.[segment.speaker]) return mappings[segment.speaker];
  if (segment.speaker === "you" || segment.source === "mic") return "You";
  if (segment.source === "system") return "Other speaker";
  return segment.speaker || "Unknown speaker";
}

function parseDate(value) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);
  return date
    ? date.toLocaleString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not documented";
}

function durationSeconds(note, encounter) {
  if (Number.isFinite(Number(note?.audio_duration_seconds))) {
    return Math.max(0, Math.round(Number(note.audio_duration_seconds)));
  }
  const start = parseDate(encounter?.start_time);
  const end = parseDate(encounter?.end_time);
  return start && end ? Math.max(0, Math.round((end - start) / 1000)) : null;
}

function normalizeSections(sections) {
  const requested = Array.isArray(sections) ? sections : ["summary", "soap", "encounterDetails"];
  return [...new Set(requested.filter((section) => SECTION_NAMES.includes(section)))];
}

function buildClinicalNoteDocument({ note, encounter, output, speakerMappings = {}, sections }) {
  const selected = normalizeSections(sections);
  const segments = parseSegments(note?.transcript);
  const participants = parseParticipants(note?.participants || encounter?.attendees);
  const duration = durationSeconds(note, encounter);
  return {
    title: note?.title || encounter?.title || "Clinical encounter",
    date: formatDate(encounter?.start_time || note?.created_at),
    duration: duration == null ? null : formatTimestamp(duration),
    encounterDetails: {
      context: encounter?.meeting_context === "in_person" ? "In person" : "Telehealth",
      status: encounter?.lifecycle_state || "completed",
    },
    participants,
    summary: String(output?.summary || "").trim(),
    soap: parseSoap(output?.soap),
    transcript: segments.map((segment) => ({
      speaker: speakerName(segment, speakerMappings),
      timestamp: formatTimestamp(segment.timestamp),
      text: segment.text,
    })),
    selectedSections: selected,
    outputStatus: {
      summary: output?.summary_status || "pending",
      soap: output?.soap_status || "pending",
    },
  };
}

function renderSection(title, content, className = "") {
  return `<section class="section ${className}"><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

function renderClinicalNoteHtml(document) {
  const selected = new Set(document.selectedSections);
  const meta = [
    `<div><span class="label">Date</span><span>${escapeHtml(document.date)}</span></div>`,
    document.duration
      ? `<div><span class="label">Duration</span><span>${escapeHtml(document.duration)}</span></div>`
      : "",
  ].join("");

  let body = "";
  if (selected.has("encounterDetails")) {
    body += renderSection(
      "Encounter details",
      `<div class="details"><div><span class="label">Context</span><span>${escapeHtml(document.encounterDetails.context)}</span></div><div><span class="label">Status</span><span>${escapeHtml(document.encounterDetails.status)}</span></div></div>`
    );
  }
  if (selected.has("participants") && document.participants.length) {
    body += renderSection(
      "Participants",
      `<p>${document.participants.map(escapeHtml).join(", ")}</p>`
    );
  }
  if (selected.has("summary")) {
    body += renderSection("Summary", `<p>${escapeHtml(document.summary || "Not documented")}</p>`);
  }
  if (selected.has("soap")) {
    const soap = SOAP_LABELS.map((label) => {
      const value = document.soap[label.toLowerCase()] || "Not documented";
      return `<div class="soap-block"><h3>${escapeHtml(label)}</h3><p>${escapeHtml(value)}</p></div>`;
    }).join("");
    body += renderSection("SOAP note", `<div class="soap-grid">${soap}</div>`);
  }
  if (selected.has("transcript")) {
    const transcript = document.transcript.length
      ? document.transcript
          .map(
            (segment) =>
              `<div class="transcript-line"><span class="timestamp">${escapeHtml(segment.timestamp)}</span><strong>${escapeHtml(segment.speaker)}</strong><p>${escapeHtml(segment.text)}</p></div>`
          )
          .join("")
      : `<p>Not documented</p>`;
    body += `<div class="transcript-appendix">${renderSection("Transcript", transcript)}</div>`;
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(document.title)}</title>
<style>
@page { size: Letter; margin: 0.62in 0.68in 0.7in; @bottom-right { content: "Page " counter(page); color: #6b7280; font-size: 8pt; } }
* { box-sizing: border-box; }
body { margin: 0; color: #1f2937; font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; line-height: 1.55; }
.header { border-bottom: 2px solid #2563eb; padding-bottom: 18px; margin-bottom: 22px; }
.brand { color: #2563eb; font-size: 9pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
h1 { color: #111827; font-size: 23pt; line-height: 1.15; margin: 8px 0 12px; }
.meta, .details { display: flex; flex-wrap: wrap; gap: 18px; color: #4b5563; font-size: 9pt; }
.meta div, .details div { display: flex; flex-direction: column; gap: 2px; }
.label { color: #6b7280; font-size: 8pt; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.section { margin: 0 0 22px; break-inside: avoid; }
h2 { color: #1d4ed8; border-bottom: 1px solid #dbeafe; font-size: 13pt; line-height: 1.25; margin: 0 0 10px; padding-bottom: 6px; }
h3 { color: #374151; font-size: 10pt; margin: 0 0 5px; }
p { margin: 0; white-space: pre-wrap; }
.soap-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.soap-block { background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; min-height: 62px; break-inside: avoid; }
.transcript-appendix { break-before: page; }
.transcript-line { display: grid; grid-template-columns: 48px 120px 1fr; gap: 8px; border-bottom: 1px solid #f1f5f9; padding: 7px 0; break-inside: avoid; }
.transcript-line p { grid-column: 3; }
.timestamp { color: #64748b; font-variant-numeric: tabular-nums; }
.footer { border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 8pt; margin-top: 28px; padding-top: 9px; }
@media print { .section, .soap-block, .transcript-line { break-inside: avoid; } }
</style></head><body>
<header class="header"><div class="brand">OpenWhispr · Clinical note</div><h1>${escapeHtml(document.title)}</h1><div class="meta">${meta}</div></header>
${body}
<footer class="footer">AI-generated note. Review and verify before clinical use. Generated ${escapeHtml(formatDate(new Date().toISOString()))}.</footer>
</body></html>`;
}

function buildClinicalNotePreview({ note, encounter, output }) {
  return {
    success: true,
    encounterId: encounter?.id || null,
    title: note?.title || encounter?.title || "Clinical encounter",
    date: formatDate(encounter?.start_time || note?.created_at),
    duration: durationSeconds(note, encounter),
    sections: {
      summary: {
        available: output?.summary_status === "ready" && Boolean(output?.summary),
        status: output?.summary_status || "pending",
      },
      soap: {
        available: output?.soap_status === "ready" && Boolean(output?.soap),
        status: output?.soap_status || "pending",
      },
      encounterDetails: { available: true, status: "ready" },
      participants: {
        available: parseParticipants(note?.participants || encounter?.attendees).length > 0,
        status: "ready",
      },
      transcript: { available: parseSegments(note?.transcript).length > 0, status: "ready" },
    },
  };
}

module.exports = {
  SECTION_NAMES,
  buildClinicalNoteDocument,
  buildClinicalNotePreview,
  escapeHtml,
  renderClinicalNoteHtml,
};
