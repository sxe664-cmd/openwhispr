const EMPTY_BEHAVIORS = new Set(["omit", "blank", "not_documented"]);

function normalizeLegacyLabel(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalFieldForLegacyLabel(label) {
  const key = normalizeLegacyLabel(label);
  if (/^(?:subjective|chief (?:complaint|concern)|history of present illness|hpi)$/.test(key)) {
    return "historyOfPresentIllness.currentComplaints";
  }
  if (/^(?:objective|physical (?:exam|examination)|examination|vitals?|vital signs)$/.test(key)) {
    return "physicalExamination.general";
  }
  if (/^(?:assessment|diagnosis|diagnoses|clinical impression)$/.test(key)) {
    return "diagnosis.assessment";
  }
  if (/^(?:plan|treatment plan|recommendations?)$/.test(key)) return "plan.treatment";
  if (/^(?:follow up|followup|return plan|next steps)$/.test(key)) return "plan.followUp";
  if (/^(?:summary|conclusion|encounter summary|clinical summary)$/.test(key)) {
    return "conclusion.encounterSummary";
  }
  if (/^(?:medical history|past medical history|previous and current illnesses|current illnesses)$/.test(key)) {
    return "previousAndCurrentIllnesses.currentIllnesses";
  }
  if (/^(?:medications?|current medications?|medications? and supplements?|supplements?)$/.test(key)) {
    return "previousAndCurrentIllnesses.medicationsAndSupplements";
  }
  if (/^(?:review of systems|ros)$/.test(key)) return "reviewOfSystems.constitutional";
  if (/^(?:interventions?|treatments? performed|procedures?)$/.test(key)) {
    return "interventions.interventionsPerformed";
  }
  const hpiFields = [
    [/^current complaints?\b/, "currentComplaints"],
    [/^immediate symptoms?\b/, "immediateSymptoms"],
    [/^delayed onset symptoms?\b/, "delayedOnsetSymptoms"],
    [/^pain level\b/, "painLevel"],
    [/^pain quality\b/, "painQuality"],
    [/^pain radiation\b/, "painRadiation"],
    [/^aggravating factors?\b/, "aggravatingFactors"],
    [/^relieving factors?\b/, "relievingFactors"],
    [/^functional limitations?\b/, "functionalLimitations"],
  ];
  const hpiField = hpiFields.find(([pattern]) => pattern.test(key));
  if (hpiField) return `historyOfPresentIllness.${hpiField[1]}`;
  return null;
}

export function validateStructuredNoteTemplate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.sections) || !value.sections.length || value.sections.length > 256) {
    throw new Error("INVALID_TEMPLATE_DEFINITION");
  }
  const seen = new Set();
  const sections = value.sections.map((section) => {
    if (!section || typeof section.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(section.id) || seen.has(section.id)) throw new Error("INVALID_TEMPLATE_SECTION");
    seen.add(section.id);
    if (typeof section.label !== "string" || !section.label.trim() || section.label.length > 200 || /[\r\n]/.test(section.label)) throw new Error("INVALID_TEMPLATE_LABEL");
    if (section.type !== "canonical" && section.type !== "narrative") throw new Error("INVALID_TEMPLATE_SECTION_TYPE");
    if (section.type === "canonical" && (typeof section.fieldId !== "string" || !/^[a-zA-Z][a-zA-Z0-9.]{0,150}$/.test(section.fieldId))) throw new Error("INVALID_TEMPLATE_FIELD");
    if (!EMPTY_BEHAVIORS.has(section.emptyBehavior)) throw new Error("INVALID_TEMPLATE_EMPTY_BEHAVIOR");
    if (section.instruction != null && (typeof section.instruction !== "string" || section.instruction.length > 1000)) throw new Error("INVALID_TEMPLATE_INSTRUCTION");
    return {
      id: section.id,
      label: section.label.trim(),
      type: section.type,
      fieldId: section.type === "canonical" ? section.fieldId : null,
      instruction: section.instruction?.trim() || "",
      emptyBehavior: section.emptyBehavior,
    };
  });
  return { version: 1, sections };
}

/** Legacy presentation text is never copied into source evidence. */
export function migrateLegacyNoteTemplate(text) {
  const sections = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^(?:#{1,6}\s+(.+)|([\p{L}][\p{L}\p{N} ,/&()'-]{1,120}):\s*)$/u);
    if (!match) continue;
    const label = (match[1] || match[2]).replace(/:\s*$/, "").trim();
    const fieldId = canonicalFieldForLegacyLabel(label);
    sections.push({
      id: `section-${sections.length + 1}`,
      label,
      type: fieldId ? "canonical" : "narrative",
      fieldId,
      instruction: "",
      emptyBehavior: "not_documented",
    });
  }
  if (!sections.length || sections.length > 256) return { definition: null, status: "needs_review" };
  return { definition: validateStructuredNoteTemplate({ version: 1, sections }), status: "valid" };
}

export function renderStructuredTemplatePreview(definition) {
  return validateStructuredNoteTemplate(definition).sections.map((section) =>
    `## ${section.label}\n\n${section.emptyBehavior === "not_documented" ? "Not documented" : ""}`
  ).join("\n\n");
}
