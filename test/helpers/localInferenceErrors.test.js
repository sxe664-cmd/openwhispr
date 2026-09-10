import assert from "node:assert/strict";
import test from "node:test";
import errors from "../../src/helpers/localInferenceErrors.js";

test("local error boundaries preserve safe categories without returning provider text", () => {
  const cases = [
    [{ message: "response_format json_schema unsupported: PRIVATE SOURCE" }, "LOCAL_SCHEMA_UNSUPPORTED"],
    [{ code: "ETIMEDOUT" }, "LOCAL_SERVER_TIMEOUT"],
    [{ code: "ECONNRESET" }, "LOCAL_SERVER_UNAVAILABLE"],
    [{ message: "Model file not found: private/path" }, "LOCAL_MODEL_NOT_AVAILABLE"],
    [{ code: "LOCAL_OUTPUT_INVALID" }, "LOCAL_OUTPUT_INVALID"],
    [{ message: "status 400: unrelated bad request" }, "LOCAL_INFERENCE_FAILED"],
    [{ message: "unrecognized PRIVATE SOURCE" }, "LOCAL_INFERENCE_FAILED"],
  ];
  for (const [error, code] of cases) assert.equal(errors.safeLocalInferenceErrorCode(error), code);
});
