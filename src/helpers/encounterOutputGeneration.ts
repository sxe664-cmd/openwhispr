import type {
  EncounterOutput,
  EncounterOutputGenerationUpdate,
  EncounterOutputType,
  EncounterTranscriptToken,
} from "../types/electron";
import {
  generateClinicalOutputs,
  type ClinicalOutputResult,
  type ClinicalOutputsResult,
} from "./clinicalOutputGeneration";

export interface EncounterOutputGenerationBridge {
  beginEncounterOutputGeneration?: (
    encounterId: number,
    outputTypes?: EncounterOutputType | Array<Exclude<EncounterOutputType, "all">>
  ) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
    transcript: string | null;
    token: EncounterTranscriptToken | null;
    busy?: boolean;
  }>;
  finishEncounterOutputGeneration?: (
    encounterId: number,
    token: EncounterTranscriptToken,
    updates: EncounterOutputGenerationUpdate
  ) => Promise<{
    success?: boolean;
    applied: boolean;
    output: EncounterOutput | null;
  }>;
  retryEncounterOutput?: (
    encounterId: number,
    outputType?: EncounterOutputType
  ) => Promise<{
    success?: boolean;
    output: EncounterOutput | null;
  }>;
}

export type EncounterOutputGenerationOutcome = {
  status: "applied" | "failed" | "superseded" | "busy";
  output: EncounterOutput | null;
};

function outputUpdates(result: ClinicalOutputsResult): EncounterOutputGenerationUpdate {
  const errorCode = (output: ClinicalOutputResult): string | null =>
    "errorCode" in output ? output.errorCode : null;
  return {
    summary: result.summary.success ? result.summary.content : null,
    summary_status: result.summary.success ? "ready" : "failed",
    summary_provider: result.summary.success ? result.summary.provider : null,
    summary_model: result.summary.success ? result.summary.model : null,
    summary_error_code: errorCode(result.summary),
    soap: result.soap.success ? result.soap.content : null,
    soap_status: result.soap.success ? "ready" : "failed",
    soap_provider: result.soap.success ? result.soap.provider : null,
    soap_model: result.soap.success ? result.soap.model : null,
    soap_error_code: errorCode(result.soap),
    focus: result.focus.success ? result.focus.content : null,
    focus_status: result.focus.success ? "ready" : "failed",
    focus_provider: result.focus.success ? result.focus.provider : null,
    focus_model: result.focus.success ? result.focus.model : null,
    focus_error_code: errorCode(result.focus),
  };
}

function failedOutputUpdates(): EncounterOutputGenerationUpdate {
  return {
    summary: null,
    summary_status: "failed",
    summary_error_code: "GENERATION_FAILED",
    soap: null,
    soap_status: "failed",
    soap_error_code: "GENERATION_FAILED",
    focus: null,
    focus_status: "failed",
    focus_error_code: "GENERATION_FAILED",
  };
}

export async function runEncounterOutputGeneration(
  bridge: EncounterOutputGenerationBridge,
  encounterId: number,
  force: boolean,
  generate: (transcript: string) => Promise<ClinicalOutputsResult> = generateClinicalOutputs,
  onBegin?: (output: EncounterOutput) => void
): Promise<EncounterOutputGenerationOutcome> {
  if (!bridge.beginEncounterOutputGeneration || !bridge.finishEncounterOutputGeneration) {
    throw new Error("Encounter output generation unavailable");
  }

  if (force && bridge.retryEncounterOutput) {
    const retried = await bridge.retryEncounterOutput(encounterId, "all");
    if (!retried.success || !retried.output) throw new Error("Encounter retry unavailable");
  }

  const begun = await bridge.beginEncounterOutputGeneration(encounterId, "all");
  if (begun.busy) {
    return { status: "busy", output: begun.output };
  }
  if (!begun.success || !begun.output || !begun.token || typeof begun.transcript !== "string") {
    throw new Error("Encounter output unavailable");
  }
  onBegin?.(begun.output);

  let generated: ClinicalOutputsResult;
  try {
    if (!begun.transcript.trim()) throw new Error("Encounter transcript unavailable");
    generated = await generate(begun.transcript);
  } catch (error) {
    const failed = await bridge.finishEncounterOutputGeneration(
      encounterId,
      begun.token,
      failedOutputUpdates()
    );
    if (!failed.success) throw error;
    return {
      status: failed.applied ? "failed" : "superseded",
      output: failed.output,
    };
  }

  const finished = await bridge.finishEncounterOutputGeneration(
    encounterId,
    begun.token,
    outputUpdates(generated)
  );
  if (!finished.success) throw new Error("Encounter output unavailable");
  return {
    status: finished.applied ? "applied" : "superseded",
    output: finished.output,
  };
}
