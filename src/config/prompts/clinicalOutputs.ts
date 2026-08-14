export type ClinicalOutputKind = "summary" | "soap" | "focus";

const COMMON_INSTRUCTIONS = `You format a clinical encounter transcript for the clinician who recorded it. Use only facts supported by the transcript. Do not invent diagnoses, medications, measurements, or plans. If information is absent, say "Not documented". Keep names and identifying details exactly as supplied; do not add any. Return JSON only, with no markdown fence or commentary.`;

export function getClinicalOutputSystemPrompt(kind: ClinicalOutputKind): string {
  if (kind === "summary") {
    return `${COMMON_INSTRUCTIONS}\nReturn exactly: {"summary":"..."}. Write a concise, readable clinical encounter summary in 1-3 short paragraphs.`;
  }

  if (kind === "focus") {
    return `${COMMON_INSTRUCTIONS}\nReturn exactly: {"focus":"..."}. Write one neutral 3-10 word phrase describing what was addressed. Do not include a diagnosis, medication, or patient name unless explicitly supported by the transcript.`;
  }

  return `${COMMON_INSTRUCTIONS}\nReturn exactly: {"soap":{"subjective":"...","objective":"...","assessment":"...","plan":"..."}}. Each value must be concise plain text. Do not infer content for a section that is not documented.`;
}
