const SAFE_CODES = new Set([
  "LOCAL_SCHEMA_UNSUPPORTED", "LOCAL_SERVER_TIMEOUT", "LOCAL_SERVER_UNAVAILABLE",
  "LOCAL_MODEL_NOT_AVAILABLE", "LOCAL_OUTPUT_INVALID", "LOCAL_INFERENCE_FAILED",
  "LOCAL_INFERENCE_CANCELLED",
]);

// Inspect provider details only at the boundary; never return or log them.
function safeLocalInferenceErrorCode(error) {
  const code = String(error?.code ?? "").toUpperCase();
  if (SAFE_CODES.has(code)) return code;
  const message = String(error?.message ?? "").toLowerCase();
  if (/response[_ ]format|json.?schema|grammar.*(?:unsupported|invalid)/.test(message)) return "LOCAL_SCHEMA_UNSUPPORTED";
  if (/TIMEOUT|TIMEDOUT/.test(code) || /timed? ?out|timeout/.test(message)) return "LOCAL_SERVER_TIMEOUT";
  if (/NOT_FOUND|NOT_DOWNLOADED/.test(code) || /model.*(?:not found|not downloaded|unavailable)/.test(message)) return "LOCAL_MODEL_NOT_AVAILABLE";
  if (/ECONN|EPIPE|SERVER/.test(code) || /connection|socket|server is not running|status 50[234]/.test(message)) return "LOCAL_SERVER_UNAVAILABLE";
  return "LOCAL_INFERENCE_FAILED";
}

module.exports = { safeLocalInferenceErrorCode };
