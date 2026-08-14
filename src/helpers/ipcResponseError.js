function errorMessage(payload, fallback) {
  if (typeof payload?.error === "string" && payload.error) return payload.error;
  if (typeof payload?.error?.message === "string" && payload.error.message) {
    return payload.error.message;
  }
  if (typeof payload?.message === "string" && payload.message) return payload.message;
  return fallback;
}

function createIpcResponseError(status, payload, fallback) {
  const code = payload?.code ?? payload?.error?.code;
  const details = payload?.data;
  const minAppVersion =
    payload?.minAppVersion ?? details?.minAppVersion ?? payload?.error?.minAppVersion;
  return Object.assign(new Error(errorMessage(payload, fallback)), {
    ...(code ? { code } : {}),
    status,
    statusCode: status,
    ...(minAppVersion ? { minAppVersion } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

function toIpcFailure(error) {
  return {
    success: false,
    error: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(error?.minAppVersion ? { minAppVersion: error.minAppVersion } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

module.exports = { createIpcResponseError, toIpcFailure };
