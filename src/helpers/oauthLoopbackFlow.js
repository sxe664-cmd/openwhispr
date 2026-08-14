const http = require("http");
const crypto = require("crypto");
const { shell } = require("electron");

const OAUTH_TIMEOUT_MS = 120000;

// Thrown by handleCallback to control the error code shown on the hosted
// desktop-callback page (defaults to "server_error").
class OAuthFlowError extends Error {
  constructor(redirectCode, message) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

function finishPage(res, message, isError = false) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<html><body style="font-family:sans-serif;padding:2rem"><h3 style="color:${
      isError ? "#b91c1c" : "#166534"
    }">${message}</h3><p>You can close this tab and return to OpenWhispr.</p></body></html>`
  );
}

// Runs a PKCE auth-code flow through an ephemeral 127.0.0.1 server:
// - buildAuthUrl(redirectUri, state, codeChallenge) → provider authorize URL
// - handleCallback(code, redirectUri, codeVerifier) → resolves the flow result;
//   called once with a state-validated code, throws (OAuthFlowError for a
//   specific callback-page code) to reject.
// - errorParam — query-param name used to classify provider errors
//   (e.g. "gcal_error"); the success param is derived from the same prefix.
function runOAuthLoopbackFlow({ buildAuthUrl, handleCallback, errorParam: _errorParam }) {
  return new Promise((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("hex");

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          finishPage(res, `Calendar authorization failed: ${error}`, true);
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h3>Invalid request.</h3></body></html>");
          return;
        }

        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const result = await handleCallback(code, redirectUri, codeVerifier);

        finishPage(res, "Calendar connected.");
        cleanup();
        resolve(result);
      } catch (err) {
        finishPage(res, `Calendar authorization failed: ${err.redirectCode || "server_error"}`, true);
        cleanup();
        reject(err);
      }
    });

    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      server.close();
    };

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      // The provider redirects back to this temporary local listener.
      shell.openExternal(buildAuthUrl(redirectUri, state, codeChallenge));
    });

    timeoutId = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out"));
    }, OAUTH_TIMEOUT_MS);

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

module.exports = { runOAuthLoopbackFlow, OAuthFlowError };
