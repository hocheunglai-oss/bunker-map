import { NextResponse } from "next/server"
import {
  createOutlookAddinAdminSession,
  getAdminRequestBearerToken,
  requireAdminPagePermissionForRequest,
  requireAdminPasswordResetSessionForRequest,
  validateOutlookAddinCredentials,
} from "@/lib/adminAuth"
import { revokeDatabaseAdminSession } from "@/lib/adminSessions"
import { completeDatabaseAdminPasswordReset } from "@/lib/adminUsers"

export const dynamic = "force-dynamic"
export const revalidate = 0

const AUTH_MESSAGE_SCHEMA = "fcuno.outlook-addin-auth/v1"

function privateHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
}

function htmlHeaders() {
  return {
    ...privateHeaders(),
    "Cache-Control":
      "public, max-age=0, s-maxage=604800, stale-while-revalidate=86400",
    "Content-Type": "text/html; charset=utf-8",
  }
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return true

  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

function jsonError(code: string, message: string, status: number) {
  return NextResponse.json(
    { code, message },
    { status, headers: privateHeaders() },
  )
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : ""
  if (message === "Unauthorized") {
    return jsonError(
      "SIGN_IN_REQUIRED",
      "The sign-in session is invalid or expired.",
      401,
    )
  }
  if (message === "Forbidden") {
    return jsonError(
      "OUTLOOK_TEMPLATES_FORBIDDEN",
      "Outlook Templates view permission is required.",
      403,
    )
  }
  if (
    message.includes("Password") ||
    message.includes("password") ||
    message.includes("Choose")
  ) {
    return jsonError("PASSWORD_RESET_FAILED", message, 400)
  }
  return jsonError(
    "OUTLOOK_AUTH_UNAVAILABLE",
    "FC Uno sign-in is temporarily unavailable.",
    503,
  )
}

async function verifyOutlookPermission(
  requestUrl: string,
  token: string,
) {
  const bearerRequest = new Request(requestUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })
  await requireAdminPagePermissionForRequest(
    bearerRequest,
    "email-templates",
    "view",
  )
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return jsonError("INVALID_ORIGIN", "Invalid request origin.", 403)
  }

  let payload: {
    action?: unknown
    username?: unknown
    password?: unknown
    confirmPassword?: unknown
  }
  try {
    payload = await request.json()
  } catch {
    return jsonError("INVALID_AUTH_REQUEST", "Invalid sign-in request.", 400)
  }

  const action = String(payload.action || "")

  if (action === "logout") {
    try {
      const token = getAdminRequestBearerToken(request)
      if (token) await revokeDatabaseAdminSession(token)
      return NextResponse.json(
        { success: true },
        { headers: privateHeaders() },
      )
    } catch (error) {
      return errorResponse(error)
    }
  }

  if (action === "login") {
    const username = typeof payload.username === "string"
      ? payload.username.trim()
      : ""
    const password = typeof payload.password === "string"
      ? payload.password
      : ""
    if (!username || username.length > 256 || !password || password.length > 256) {
      return jsonError(
        "INVALID_CREDENTIALS",
        "Invalid username or password.",
        401,
      )
    }

    try {
      const user = await validateOutlookAddinCredentials(username, password)
      if (!user) {
        return jsonError(
          "INVALID_CREDENTIALS",
          "Invalid username or password.",
          401,
        )
      }

      const session = await createOutlookAddinAdminSession(user)
      if (!user.passwordResetRequired) {
        try {
          await verifyOutlookPermission(request.url, session.token)
        } catch (error) {
          await revokeDatabaseAdminSession(session.token)
          throw error
        }
      }

      return NextResponse.json(
        {
          success: true,
          resetRequired: user.passwordResetRequired,
          token: session.token,
          expiresAt: session.expiresAt,
        },
        { headers: privateHeaders() },
      )
    } catch (error) {
      return errorResponse(error)
    }
  }

  if (action === "reset-password") {
    const password = typeof payload.password === "string"
      ? payload.password
      : ""
    const confirmPassword = typeof payload.confirmPassword === "string"
      ? payload.confirmPassword
      : ""
    if (password !== confirmPassword) {
      return jsonError(
        "PASSWORD_RESET_FAILED",
        "The new passwords do not match.",
        400,
      )
    }

    try {
      const token = getAdminRequestBearerToken(request)
      if (!token) throw new Error("Unauthorized")
      const session = await requireAdminPasswordResetSessionForRequest(request)
      await completeDatabaseAdminPasswordReset({
        adminUserId: session.adminUserId,
        sessionId: session.sessionId,
        newPassword: password,
      })

      return NextResponse.json(
        {
          success: true,
          resetRequired: false,
          expiresAt: session.expiresAt,
        },
        { headers: privateHeaders() },
      )
    } catch (error) {
      return errorResponse(error)
    }
  }

  return jsonError("INVALID_AUTH_REQUEST", "Invalid sign-in request.", 400)
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (url.searchParams.get("mode") === "session") {
    try {
      const session = await requireAdminPagePermissionForRequest(
        request,
        "email-templates",
        "view",
      )
      return NextResponse.json(
        {
          authenticated: true,
          username: session.username,
          displayName: session.displayName || session.username,
          expiresAt: session.expiresAt,
        },
        { headers: privateHeaders() },
      )
    } catch (error) {
      return errorResponse(error)
    }
  }

  const authUrl = `${url.origin}${url.pathname}`
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in to FC Uno</title>
    <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #f4f6f8;
        color: #172534;
        font-family: Roboto, Arial, Helvetica, sans-serif;
      }
      .card {
        width: min(100%, 390px);
        padding: 24px;
        border: 1px solid #dbe4ec;
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 12px 28px rgba(23, 37, 52, 0.08);
      }
      h1 { margin: 0 0 8px; font-size: 21px; line-height: 1.25; }
      p { margin: 0 0 18px; color: #526679; font-size: 13px; line-height: 1.5; }
      form { display: grid; gap: 12px; }
      label { display: grid; gap: 6px; color: #34495d; font-size: 12px; font-weight: 800; }
      input {
        width: 100%;
        height: 42px;
        border: 1px solid #c4d0da;
        border-radius: 7px;
        background: #fff;
        color: #172534;
        outline: none;
        padding: 0 11px;
        font: inherit;
      }
      input:focus { border-color: #1672b9; box-shadow: 0 0 0 3px rgba(22, 114, 185, 0.12); }
      button {
        min-height: 42px;
        border: 0;
        border-radius: 999px;
        background: #1672b9;
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 900;
        padding: 0 18px;
      }
      button:disabled { cursor: wait; opacity: 0.65; }
      .message { min-height: 18px; margin-top: 14px; color: #a12a2a; font-size: 12px; line-height: 1.45; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main class="card">
      <section id="loginPanel">
        <h1>Sign in to FC Uno</h1>
        <p>Use your FC Uno account to access approved Outlook templates.</p>
        <form id="loginForm">
          <label>
            Username
            <input id="username" name="username" autocomplete="username" maxlength="256" required />
          </label>
          <label>
            Password
            <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required />
          </label>
          <button id="loginButton" type="submit">Sign in</button>
        </form>
      </section>
      <section id="resetPanel" hidden>
        <h1>Set a new password</h1>
        <p>Your account requires a password change before Outlook Templates can open.</p>
        <form id="resetForm">
          <label>
            New password
            <input id="newPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required />
          </label>
          <label>
            Confirm new password
            <input id="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="256" required />
          </label>
          <button id="resetButton" type="submit">Update password</button>
        </form>
      </section>
      <div id="message" class="message" role="alert"></div>
    </main>
    <script>
      (function () {
        var AUTH_URL = ${JSON.stringify(authUrl)};
        var AUTH_MESSAGE_SCHEMA = ${JSON.stringify(AUTH_MESSAGE_SCHEMA)};
        var pendingSession = null;
        var officeReady = new Promise(function (resolve) {
          if (window.Office && typeof window.Office.onReady === "function") {
            window.Office.onReady(function () { resolve(); });
            return;
          }
          resolve();
        });
        var loginPanel = document.getElementById("loginPanel");
        var resetPanel = document.getElementById("resetPanel");
        var loginForm = document.getElementById("loginForm");
        var resetForm = document.getElementById("resetForm");
        var loginButton = document.getElementById("loginButton");
        var resetButton = document.getElementById("resetButton");
        var message = document.getElementById("message");

        function setMessage(text) {
          message.textContent = text || "";
        }

        function setBusy(button, busy) {
          button.disabled = Boolean(busy);
        }

        async function postAuth(payload, token) {
          var headers = { "Content-Type": "application/json" };
          if (token) headers.Authorization = "Bearer " + token;
          var response = await fetch(AUTH_URL, {
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            headers: headers,
            body: JSON.stringify(payload)
          });
          var data = await response.json().catch(function () { return {}; });
          if (!response.ok) {
            throw new Error(data.message || "FC Uno sign-in failed.");
          }
          return data;
        }

        async function sendAuthenticatedSession(session) {
          await officeReady;
          if (!window.Office ||
              !window.Office.context ||
              !window.Office.context.ui ||
              typeof window.Office.context.ui.messageParent !== "function") {
            throw new Error("This Outlook client cannot complete secure sign-in.");
          }
          window.Office.context.ui.messageParent(JSON.stringify({
            schema: AUTH_MESSAGE_SCHEMA,
            token: session.token,
            expiresAt: session.expiresAt
          }));
        }

        loginForm.addEventListener("submit", async function (event) {
          event.preventDefault();
          setBusy(loginButton, true);
          setMessage("");
          try {
            var data = await postAuth({
              action: "login",
              username: document.getElementById("username").value,
              password: document.getElementById("password").value
            });
            if (!data.token || !data.expiresAt) {
              throw new Error("FC Uno returned an invalid sign-in session.");
            }
            pendingSession = {
              token: String(data.token),
              expiresAt: String(data.expiresAt)
            };
            document.getElementById("password").value = "";
            if (data.resetRequired === true) {
              loginPanel.hidden = true;
              resetPanel.hidden = false;
              document.getElementById("newPassword").focus();
              return;
            }
            await sendAuthenticatedSession(pendingSession);
          } catch (error) {
            pendingSession = null;
            setMessage(error && error.message ? error.message : "FC Uno sign-in failed.");
          } finally {
            setBusy(loginButton, false);
          }
        });

        resetForm.addEventListener("submit", async function (event) {
          event.preventDefault();
          if (!pendingSession) {
            resetPanel.hidden = true;
            loginPanel.hidden = false;
            setMessage("Sign in again to update your password.");
            return;
          }
          setBusy(resetButton, true);
          setMessage("");
          try {
            var newPassword = document.getElementById("newPassword").value;
            var confirmPassword = document.getElementById("confirmPassword").value;
            var data = await postAuth({
              action: "reset-password",
              password: newPassword,
              confirmPassword: confirmPassword
            }, pendingSession.token);
            if (data.resetRequired !== false) {
              throw new Error("FC Uno could not complete the password update.");
            }
            await sendAuthenticatedSession(pendingSession);
          } catch (error) {
            setMessage(error && error.message ? error.message : "Password update failed.");
          } finally {
            document.getElementById("newPassword").value = "";
            document.getElementById("confirmPassword").value = "";
            setBusy(resetButton, false);
          }
        });
      })();
    </script>
  </body>
</html>`

  return new NextResponse(html, { headers: htmlHeaders() })
}
