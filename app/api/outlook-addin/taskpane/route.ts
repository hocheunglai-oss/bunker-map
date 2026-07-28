import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { requireOutlookAddinPagePermissionForRequest } from "@/lib/adminAuth"

export const dynamic = "force-dynamic"
export const revalidate = 0

const RECIPIENT_MAP_TTL_SECONDS = 120
const DEFAULT_CERTIFICATION_MAX_AGE_SECONDS = 36 * 60 * 60
const MAX_CERTIFICATION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

function buildBaseUrl(request: Request) {
  return new URL(request.url).origin
}

function htmlHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control":
      "public, max-age=0, s-maxage=604800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function getAuditClient() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
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

function jsonHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
}

function jsonError(
  code: string,
  message: string,
  status: number,
) {
  return NextResponse.json(
    { code, message },
    { status, headers: jsonHeaders() },
  )
}

type InsertionAuditPhase = "reserved" | "terminal"
type InsertionAuditOutcome =
  | "inserted"
  | "failed-restored"
  | "failed-preserved"

type InsertionAttemptIdentity = {
  operationId: string
  templateId: string
  templateRevision: number
  certificationRunId: string
  sourceFingerprint: string
  actorId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function certificationMaxAgeSeconds() {
  const configured = Number(process.env.OUTLOOK_ADDIN_CERTIFICATION_MAX_AGE_SECONDS)
  if (!Number.isFinite(configured)) return DEFAULT_CERTIFICATION_MAX_AGE_SECONDS
  return Math.max(
    RECIPIENT_MAP_TTL_SECONDS,
    Math.min(Math.floor(configured), MAX_CERTIFICATION_MAX_AGE_SECONDS),
  )
}

function insertionAuditSuccess(phase: InsertionAuditPhase) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Outlook-Insertion-Audit-Phase": phase,
    },
  })
}

export async function POST(request: Request) {
  try {
    const session = await requireOutlookAddinPagePermissionForRequest(
      request,
      "email-templates",
      "view",
    )
    if (!isSameOrigin(request)) {
      return jsonError("INVALID_ORIGIN", "Invalid request origin.", 403)
    }

    let payload: Record<string, unknown>
    try {
      const parsedPayload: unknown = await request.json()
      if (!isRecord(parsedPayload)) {
        return jsonError(
          "INVALID_INSERT_AUDIT",
          "Invalid insertion audit payload.",
          400,
        )
      }
      payload = parsedPayload
    } catch {
      return jsonError(
        "INVALID_INSERT_AUDIT",
        "Invalid insertion audit payload.",
        400,
      )
    }
    const operationId = String(payload.operationId || "").trim().toLowerCase()
    const phase = String(payload.phase || "").trim().toLowerCase()
    const outcome = payload.outcome === undefined
      ? null
      : String(payload.outcome || "").trim().toLowerCase()
    const templateId = String(payload.templateId || "").trim()
    const templateRevision = Number(payload.templateRevision)
    const certificationRunId = String(payload.certificationRunId || "").trim().toLowerCase()
    const sourceFingerprint = String(payload.sourceFingerprint || "").trim().toLowerCase()
    const validPhase = phase === "reserved" || phase === "terminal"
    const validOutcome =
      outcome === "inserted" ||
      outcome === "failed-restored" ||
      outcome === "failed-preserved"
    if (
      !validPhase ||
      (phase === "reserved" ? outcome !== null : !validOutcome) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !templateId ||
      templateId.length > 256 ||
      !Number.isSafeInteger(templateRevision) ||
      templateRevision < 1 ||
      templateRevision > 2147483647 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        certificationRunId,
      ) ||
      !/^[0-9a-f]{64}$/.test(sourceFingerprint)
    ) {
      return jsonError(
        "INVALID_INSERT_AUDIT",
        "Invalid insertion audit payload.",
        400,
      )
    }

    const actorId = String(session.username || "").trim()
    if (!actorId) throw new Error("Authenticated admin identity is unavailable.")
    const attemptIdentity: InsertionAttemptIdentity = {
      operationId,
      templateId,
      templateRevision,
      certificationRunId,
      sourceFingerprint,
      actorId,
    }
    const auditClient = getAuditClient()
    const typedPhase = phase as InsertionAuditPhase
    const typedOutcome = outcome as InsertionAuditOutcome | null

    if (typedPhase === "reserved") {
      const { error: reservationError } = await auditClient.rpc(
        "reserve_outlook_template_insertion",
        {
          p_operation_id: attemptIdentity.operationId,
          p_template_id: attemptIdentity.templateId,
          p_template_revision: attemptIdentity.templateRevision,
          p_certification_run_id: attemptIdentity.certificationRunId,
          p_source_fingerprint: attemptIdentity.sourceFingerprint,
          p_actor_id: attemptIdentity.actorId,
          p_actor_name: session.displayName || actorId,
          p_certification_max_age_seconds: certificationMaxAgeSeconds(),
        },
      )
      if (!reservationError) {
        return insertionAuditSuccess("reserved")
      }

      const reservationMessage = String(reservationError.message || "")
      if (reservationMessage.includes("OUTLOOK_INSERTION_TEMPLATE_CHANGED")) {
        return jsonError(
          "TEMPLATE_REVISION_CHANGED",
          "The template changed before the insertion could be reserved.",
          409,
        )
      }
      if (reservationMessage.includes("OUTLOOK_INSERTION_TRUTH_STALE")) {
        return jsonError(
          "INSERT_CERTIFICATION_CHANGED",
          "The certified address book is no longer exact, settled, and current.",
          409,
        )
      }
      if (reservationMessage.includes("OUTLOOK_INSERTION_RESERVATION_EXPIRED")) {
        return jsonError(
          "INSERT_RESERVATION_EXPIRED",
          "The insertion reservation expired. Start the insertion again.",
          409,
        )
      }
      if (reservationMessage.includes("OUTLOOK_INSERTION_STATE_BUSY")) {
        return jsonError(
          "INSERT_RESERVATION_BUSY",
          "The template or certified address book is changing. Please try again.",
          409,
        )
      }
      if (
        reservationMessage.includes("OUTLOOK_INSERTION_OPERATION_CONFLICT") ||
        reservationMessage.includes("OUTLOOK_INSERTION_OPERATION_COMPLETED") ||
        reservationError.code === "23505"
      ) {
        return jsonError(
          "INSERT_OPERATION_CONFLICT",
          "The insertion operation is already in use or has completed.",
          409,
        )
      }
      throw reservationError
    }

    const { error: terminalError } = await auditClient.rpc(
      "complete_outlook_template_insertion",
      {
        p_operation_id: attemptIdentity.operationId,
        p_template_id: attemptIdentity.templateId,
        p_template_revision: attemptIdentity.templateRevision,
        p_certification_run_id: attemptIdentity.certificationRunId,
        p_source_fingerprint: attemptIdentity.sourceFingerprint,
        p_actor_id: attemptIdentity.actorId,
        p_actor_name: session.displayName || actorId,
        p_outcome: typedOutcome!,
      },
    )
    if (!terminalError) {
      return insertionAuditSuccess("terminal")
    }

    const terminalMessage = String(terminalError.message || "")
    if (terminalMessage.includes("OUTLOOK_INSERTION_RESERVATION_EXPIRED")) {
      return jsonError(
        "INSERT_RESERVATION_EXPIRED",
        "The insertion reservation expired before its outcome could be recorded.",
        409,
      )
    }
    if (terminalMessage.includes("OUTLOOK_INSERTION_RESERVATION_REQUIRED")) {
      return jsonError(
        "INSERT_RESERVATION_REQUIRED",
        "A matching insertion reservation is required.",
        409,
      )
    }
    if (
      terminalMessage.includes("OUTLOOK_INSERTION_TERMINAL_CONFLICT") ||
      terminalError.code === "23505"
    ) {
      return jsonError(
        "INSERT_TERMINAL_CONFLICT",
        "This insertion operation already has a different terminal outcome.",
        409,
      )
    }
    throw terminalError
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return jsonError("SIGN_IN_REQUIRED", "Sign in required.", 401)
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return jsonError(
        "OUTLOOK_TEMPLATES_FORBIDDEN",
        "Permission required.",
        403,
      )
    }
    return jsonError(
      "INSERT_AUDIT_FAILED",
      "Template insertion audit could not be recorded.",
      503,
    )
  }
}

export async function GET(request: Request) {
  const baseUrl = buildBaseUrl(request)
  const authDialogUrl = `${baseUrl}/api/outlook-addin/auth-dialog`
  const templateIndexUrl = `${baseUrl}/api/email-templates?mode=index`
  const templateDetailUrl = `${baseUrl}/api/email-templates`
  const recipientMapUrl = `${baseUrl}/api/outlook-addin/recipient-map`
  const insertionAuditUrl = `${baseUrl}/api/outlook-addin/taskpane`
  const naaClientId = process.env.OUTLOOK_ADDIN_NAA_CLIENT_ID || ""
  const naaTenantId =
    process.env.OUTLOOK_ADDIN_NAA_TENANT_ID ||
    process.env.EXCHANGE_TENANT_ID ||
    ""
  const naaAuthority = naaTenantId
    ? `https://login.microsoftonline.com/${naaTenantId}`
    : ""

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fratelli Cosulich Templates</title>
    <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        background: #f4f6f8;
        color: #172534;
        font-family: Roboto, Arial, Helvetica, sans-serif;
      }
      button, input { font: inherit; }
      [hidden] { display: none !important; }
      .auth {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 18px;
      }
      .authCard {
        width: min(100%, 360px);
        padding: 20px;
        border: 1px solid #dbe4ec;
        border-radius: 10px;
        background: #fff;
        box-shadow: 0 12px 28px rgba(23, 37, 52, 0.08);
      }
      .authCard h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.3; }
      .authCard p { margin: 0 0 16px; color: #526679; font-size: 12px; line-height: 1.5; }
      .authButton {
        min-height: 40px;
        border: 0;
        border-radius: 999px;
        background: #1672b9;
        color: #fff;
        cursor: pointer;
        font-size: 13px;
        font-weight: 900;
        padding: 0 17px;
      }
      .authButton:disabled { cursor: wait; opacity: 0.65; }
      .authMessage { min-height: 18px; margin-top: 12px; color: #a12a2a; font-size: 11px; line-height: 1.45; }
      .app { display: grid; gap: 8px; padding: 8px; }
      .search {
        width: 100%;
        height: 38px;
        border: 1px solid #c4d0da;
        border-radius: 7px;
        background: #fff;
        color: #172534;
        outline: none;
        padding: 0 10px;
      }
      .search:focus { border-color: #1672b9; box-shadow: 0 0 0 3px rgba(22, 114, 185, 0.12); }
      .panel {
        border: 1px solid #dbe4ec;
        border-radius: 8px;
        background: #fff;
        overflow: hidden;
      }
      .panelHeader {
        min-height: 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 9px;
        border-bottom: 1px solid #e4ebf1;
        background: #fbfcfd;
        color: #435565;
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .panelHeaderButton {
        border: 0;
        background: transparent;
        color: #536b7e;
        cursor: pointer;
        font: inherit;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .panelHeaderButton:disabled { cursor: wait; opacity: 0.55; }
      .folders { max-height: 35vh; overflow: auto; padding: 5px; }
      .templates { max-height: 54vh; overflow: auto; padding: 5px; }
      .folderNode { position: relative; }
      .folderChildren {
        margin-left: 9px;
        padding-left: 8px;
        border-left: 1px solid #d9e5ee;
      }
      .folderRow {
        width: 100%;
        min-height: 28px;
        display: grid;
        grid-template-columns: 16px minmax(0, 1fr);
        align-items: center;
        gap: 5px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #203246;
        cursor: pointer;
        text-align: left;
      }
      .folderRow.active { background: #dff0fb; color: #0c4774; }
      .folderToggle {
        color: #6a7f91;
        font-size: 12px;
        font-weight: 900;
        text-align: center;
      }
      .folderName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 800; }
      .templateGridHeader {
        display: none;
        gap: 8px;
        padding: 0 9px 5px;
        color: #6a7a89;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .templateRow {
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
        align-items: center;
        margin-bottom: 5px;
        padding: 8px 9px;
        border: 1px solid #e2e9ef;
        border-radius: 7px;
        background: #fff;
        color: #1b2d40;
        cursor: pointer;
        text-align: left;
      }
      .templateRow.active { border-color: #2c86c6; background: #eef7ff; }
      .recipient {
        display: none;
        min-width: 0;
        color: #536676;
        font-size: 12px;
        font-weight: 800;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title { min-width: 0; display: block; font-size: 13px; font-weight: 900; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      @media (min-width: 520px) {
        .templateGridHeader { display: grid; grid-template-columns: minmax(92px, 34%) minmax(0, 1fr); }
        .templateRow { grid-template-columns: minmax(92px, 34%) minmax(0, 1fr); }
        .recipient { display: block; }
      }
      .empty { padding: 14px 10px; color: #617487; font-size: 12px; line-height: 1.45; }
      .notice {
        min-height: 18px;
        color: #526679;
        font-size: 11px;
        line-height: 1.35;
      }
      .notice.error { color: #a12a2a; }
      .notice.success { color: #1d6a3b; }
    </style>
  </head>
  <body>
    <section id="authPanel" class="auth">
      <div class="authCard">
        <h1>Sign in required</h1>
        <p id="authText">Sign in securely to load approved FC Uno Outlook templates.</p>
        <button id="signInButton" class="authButton" type="button">Sign in to FC Uno</button>
        <div id="authMessage" class="authMessage" role="alert"></div>
      </div>
    </section>
    <div id="templateApp" class="app" hidden>
      <input id="searchInput" class="search" type="search" placeholder="Search templates" autocomplete="off" />
      <section class="panel">
        <div class="panelHeader">
          <span>Folders</span>
          <button id="signOutButton" class="panelHeaderButton" type="button">Sign out</button>
        </div>
        <div id="folderTree" class="folders"><div class="empty">Loading...</div></div>
      </section>
      <section class="panel">
        <div class="panelHeader"><span id="listTitle">Templates</span></div>
        <div id="templateList" class="templates"><div class="empty">Loading...</div></div>
      </section>
      <div id="notice" class="notice"></div>
    </div>

    <script>
      (function () {
        var AUTH_DIALOG_URL = ${JSON.stringify(authDialogUrl)};
        var TEMPLATE_INDEX_URL = ${JSON.stringify(templateIndexUrl)};
        var TEMPLATE_DETAIL_URL = ${JSON.stringify(templateDetailUrl)};
        var RECIPIENT_MAP_URL = ${JSON.stringify(recipientMapUrl)};
        var INSERTION_AUDIT_URL = ${JSON.stringify(insertionAuditUrl)};
        var NAA_CLIENT_ID = ${JSON.stringify(naaClientId)};
        var NAA_AUTHORITY = ${JSON.stringify(naaAuthority)};
        var GRAPH_SCOPES = ["Mail.ReadWrite"];
        var MSAL_SCRIPT_URL = "/outlook-msal-browser-4.24.1.min.js";
        var AUTH_SESSION_KEY = "fcuno-outlook-addin-auth-v2";
        var LEGACY_AUTH_SESSION_KEY = "fcuno-outlook-addin-auth-v1";
        var AUTH_SESSION_SCHEMA = "fcuno.outlook-addin-auth-session/v1";
        var AUTH_MESSAGE_SCHEMA = "fcuno.outlook-addin-auth/v1";
        var AUTH_SESSION_MAX_TTL_MS = 400 * 24 * 60 * 60 * 1000;
        var AUTH_SESSION_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
        var INDEX_CACHE_KEY = "fcuno-outlook-template-index-v6";
        var RECIPIENT_MAP_CACHE_KEY = "fcuno-outlook-certified-recipient-map-v5";
        var INDEX_CACHE_SCHEMA = "fcuno.outlook-template-index-cache/v1";
        var RECIPIENT_CACHE_SCHEMA = "fcuno.outlook-recipient-map-cache/v1";
        var INDEX_CACHE_TTL_MS = 2 * 60 * 1000;
        var state = {
          templates: [],
          detailCache: {},
          recipientsBySourceKey: {},
          recipientMapLoaded: false,
          recipientMapFromNetwork: false,
          recipientMapExpiresAt: 0,
          recipientCertification: null,
          recipientMapPromise: null,
          folderRoot: null,
          folderIndex: {},
          expanded: { "": true },
          selectedFolder: "",
          selectedId: "",
          query: "",
          inserting: false,
          authenticated: false,
          authSession: null,
          authMode: "none",
          authGeneration: 0,
          authExpiryTimer: null,
          authDialog: null,
          msalScriptPromise: null,
          graphClientPromise: null
        };

        var els = {
          authPanel: document.getElementById("authPanel"),
          authText: document.getElementById("authText"),
          authMessage: document.getElementById("authMessage"),
          signInButton: document.getElementById("signInButton"),
          signOutButton: document.getElementById("signOutButton"),
          templateApp: document.getElementById("templateApp"),
          search: document.getElementById("searchInput"),
          folderTree: document.getElementById("folderTree"),
          listTitle: document.getElementById("listTitle"),
          templateList: document.getElementById("templateList"),
          notice: document.getElementById("notice")
        };

        function notice(text, kind) {
          els.notice.textContent = text || "";
          els.notice.className = "notice" + (kind ? " " + kind : "");
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function clearConfidentialState(removeStoredCaches) {
          state.templates = [];
          state.detailCache = {};
          state.folderRoot = null;
          state.folderIndex = {};
          state.expanded = { "": true };
          state.selectedFolder = "";
          state.selectedId = "";
          state.query = "";
          state.inserting = false;
          clearRecipientMap(removeStoredCaches);
          if (removeStoredCaches) {
            try {
              if (window.localStorage) {
                window.localStorage.removeItem(INDEX_CACHE_KEY);
                window.localStorage.removeItem(RECIPIENT_MAP_CACHE_KEY);
              }
            } catch (error) {
              // Continue clearing rendered and in-memory confidential state.
            }
          }
          els.search.value = "";
          els.folderTree.innerHTML = '<div class="empty">Sign in to load folders.</div>';
          els.templateList.innerHTML = '<div class="empty">Sign in to load templates.</div>';
        }

        function showAuthenticationState(message, permissionRequired) {
          els.templateApp.hidden = true;
          els.authPanel.hidden = false;
          els.authText.textContent = permissionRequired
            ? "Your FC Uno account needs Outlook Templates view permission."
            : "Sign in securely to load approved FC Uno Outlook templates.";
          els.authMessage.textContent = message || "";
          els.signInButton.disabled = Boolean(state.authDialog);
        }

        function showAuthenticatedApp() {
          els.authMessage.textContent = "";
          els.authPanel.hidden = true;
          els.templateApp.hidden = false;
        }

        function clearAuthExpiryTimer() {
          if (state.authExpiryTimer !== null) {
            window.clearTimeout(state.authExpiryTimer);
            state.authExpiryTimer = null;
          }
        }

        function removeStoredAuthSessions() {
          try {
            if (window.localStorage) {
              window.localStorage.removeItem(AUTH_SESSION_KEY);
            }
          } catch (localStorageError) {
            // Continue clearing every other storage and the in-memory session.
          }
          try {
            if (window.sessionStorage) {
              window.sessionStorage.removeItem(AUTH_SESSION_KEY);
              window.sessionStorage.removeItem(LEGACY_AUTH_SESSION_KEY);
            }
          } catch (sessionStorageError) {
            // The in-memory session is still cleared if storage is unavailable.
          }
        }

        function clearAuthentication(message, permissionRequired) {
          state.authGeneration += 1;
          state.authenticated = false;
          state.authSession = null;
          state.authMode = "none";
          clearAuthExpiryTimer();
          removeStoredAuthSessions();
          clearConfidentialState(true);
          showAuthenticationState(message, permissionRequired);
        }

        function scheduleAuthExpiry(expiresAt) {
          clearAuthExpiryTimer();
          function checkExpiry() {
            var remaining = expiresAt - Date.now();
            if (remaining <= 0) {
              clearAuthentication(
                "Your FC Uno sign-in expired. Sign in again.",
                false
              );
              return;
            }
            state.authExpiryTimer = window.setTimeout(
              checkExpiry,
              Math.min(remaining, 2147483647)
            );
          }
          checkExpiry();
        }

        function parseAuthSession(input, expectedSchema) {
          if (!input ||
              input.schema !== expectedSchema ||
              !/^[A-Za-z0-9_-]{40,256}$/.test(String(input.token || ""))) {
            return null;
          }
          var expiresAt = Date.parse(String(input.expiresAt || ""));
          var now = Date.now();
          if (!Number.isFinite(expiresAt) ||
              expiresAt <= now ||
              expiresAt >
                now + AUTH_SESSION_MAX_TTL_MS + AUTH_SESSION_CLOCK_SKEW_MS) {
            return null;
          }
          return {
            token: String(input.token),
            expiresAt: expiresAt
          };
        }

        function parseAuthExpiry(input) {
          var expiresAt = Date.parse(String(input && input.expiresAt || ""));
          var now = Date.now();
          if (!Number.isFinite(expiresAt) ||
              expiresAt <= now ||
              expiresAt >
                now + AUTH_SESSION_MAX_TTL_MS + AUTH_SESSION_CLOCK_SKEW_MS) {
            return null;
          }
          return expiresAt;
        }

        function restoreAuthSession() {
          var stored = null;
          try {
            stored = window.localStorage &&
              window.localStorage.getItem(AUTH_SESSION_KEY);
          } catch (localStorageError) {
            stored = null;
          }
          try {
            if (!stored && window.sessionStorage) {
              stored =
                window.sessionStorage.getItem(AUTH_SESSION_KEY) ||
                window.sessionStorage.getItem(LEGACY_AUTH_SESSION_KEY);
            }
          } catch (sessionStorageError) {
            stored = null;
          }
          if (!stored) return null;
          try {
            var parsed = parseAuthSession(JSON.parse(stored), AUTH_SESSION_SCHEMA);
            if (!parsed) {
              removeStoredAuthSessions();
              return null;
            }
            persistAuthSession(parsed);
            return parsed;
          } catch (parseError) {
            removeStoredAuthSessions();
            return null;
          }
        }

        function persistAuthSession(session) {
          var stored = {
            schema: AUTH_SESSION_SCHEMA,
            token: session.token,
            expiresAt: new Date(session.expiresAt).toISOString()
          };
          var persisted = false;
          try {
            if (window.localStorage) {
              window.localStorage.setItem(
                AUTH_SESSION_KEY,
                JSON.stringify(stored)
              );
              persisted = true;
            }
          } catch (persistentStorageError) {
            persisted = false;
          }
          if (persisted) {
            try {
              if (window.sessionStorage) {
                window.sessionStorage.removeItem(AUTH_SESSION_KEY);
                window.sessionStorage.removeItem(LEGACY_AUTH_SESSION_KEY);
              }
            } catch (sessionCleanupError) {
              // Persistent storage is authoritative even if legacy cleanup fails.
            }
            return;
          }
          try {
            if (window.sessionStorage) {
              window.sessionStorage.setItem(
                AUTH_SESSION_KEY,
                JSON.stringify(stored)
              );
              return;
            }
          } catch (sessionStorageError) {
            // Report one storage error below.
          }
          if (!persisted) {
            throw new Error("This Outlook client cannot store a secure session.");
          }
        }

        function applyAuthSession(parsed, advanceGeneration) {
          persistAuthSession(parsed);
          if (advanceGeneration) state.authGeneration += 1;
          state.authSession = parsed;
          state.authMode = "bearer";
          scheduleAuthExpiry(parsed.expiresAt);
          return parsed;
        }

        function applyCookieAuthSession(input, advanceGeneration) {
          var expiresAt = parseAuthExpiry(input);
          if (!expiresAt) {
            throw new Error("FC Uno returned an invalid renewed session.");
          }
          if (advanceGeneration) state.authGeneration += 1;
          state.authSession = { token: "", expiresAt: expiresAt };
          state.authMode = "cookie";
          scheduleAuthExpiry(expiresAt);
          removeStoredAuthSessions();
          return state.authSession;
        }

        function storeAuthSession(message) {
          var parsed = parseAuthSession(message, AUTH_MESSAGE_SCHEMA);
          if (!parsed) {
            throw new Error("FC Uno returned an invalid sign-in session.");
          }
          state.authGeneration += 1;
          state.authenticated = false;
          return applyAuthSession(parsed, false);
        }

        function refreshAuthSessionExpiry(expiresAt) {
          if (state.authMode === "cookie") {
            return applyCookieAuthSession({ expiresAt: expiresAt }, false);
          }
          var current = state.authSession;
          var refreshed = parseAuthSession(
            {
              schema: AUTH_SESSION_SCHEMA,
              token: current && current.token,
              expiresAt: expiresAt
            },
            AUTH_SESSION_SCHEMA
          );
          if (!refreshed) {
            throw new Error("FC Uno returned an invalid renewed session.");
          }
          return applyAuthSession(refreshed, false);
        }

        function currentAuthSession() {
          var session = state.authSession;
          if (!session || session.expiresAt <= Date.now()) {
            clearAuthentication("Your FC Uno sign-in expired. Sign in again.", false);
            return null;
          }
          return session;
        }

        function assertAuthRequestCurrent(context) {
          var current = state.authSession;
          if (!current ||
              context.generation !== state.authGeneration ||
              context.mode !== state.authMode ||
              (context.mode === "bearer" && context.token !== current.token)) {
            throw new Error("The FC Uno sign-in changed while loading data.");
          }
        }

        async function authenticatedFetch(url, options) {
          var session = currentAuthSession();
          if (!session) throw new Error("Sign in to FC Uno to continue.");
          var generation = state.authGeneration;
          var headers = {};
          var inputHeaders = options && options.headers ? options.headers : {};
          Object.keys(inputHeaders).forEach(function (name) {
            headers[name] = inputHeaders[name];
          });
          if (state.authMode === "bearer") {
            headers.Authorization = "Bearer " + session.token;
          }
          var requestOptions = Object.assign({}, options || {}, {
            cache: "no-store",
            credentials: state.authMode === "cookie" ? "include" : "omit",
            headers: headers
          });
          var response = await fetch(url, requestOptions);
          var context = {
            generation: generation,
            mode: state.authMode,
            token: state.authMode === "bearer" ? session.token : ""
          };
          assertAuthRequestCurrent(context);
          if (response.status === 401) {
            clearAuthentication("Your FC Uno sign-in is invalid or expired.", false);
            throw new Error("Sign in to FC Uno to continue.");
          }
          if (response.status === 403) {
            clearAuthentication(
              "Outlook Templates view permission is required.",
              true
            );
            throw new Error("Outlook Templates view permission is required.");
          }
          return { response: response, context: context };
        }

        function closeAuthDialog() {
          if (state.authDialog) {
            try {
              state.authDialog.close();
            } catch (error) {
              // Outlook may already have closed the dialog.
            }
          }
          state.authDialog = null;
          els.signInButton.disabled = false;
        }

        async function signOut() {
          els.signOutButton.disabled = true;
          try {
            await authenticatedFetch(AUTH_DIALOG_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "logout" })
            });
          } catch (error) {
            // Local sign-out still completes if the revocation request fails.
          } finally {
            els.signOutButton.disabled = false;
            clearAuthentication("Signed out.", false);
          }
        }

        async function validateAuthenticationAndLoad() {
          var result;
          try {
            result = await authenticatedFetch(AUTH_DIALOG_URL + "?mode=session");
            if (!result.response.ok) {
              throw new Error("FC Uno could not verify this sign-in.");
            }
            var validation = await result.response.json();
            assertAuthRequestCurrent(result.context);
            refreshAuthSessionExpiry(validation.expiresAt);
            state.authenticated = true;
            showAuthenticatedApp();
            await loadTemplates();
            warmInsertionDependencies();
          } catch (error) {
            if (!state.authSession) return;
            state.authenticated = false;
            showAuthenticationState(
              error && error.message
                ? error.message
                : "FC Uno could not verify this sign-in.",
              false
            );
          }
        }

        async function validateCookieAuthenticationAndLoad() {
          var validationGeneration = state.authGeneration + 1;
          state.authGeneration = validationGeneration;
          try {
            var response = await fetch(AUTH_DIALOG_URL + "?mode=session", {
              cache: "no-store",
              credentials: "include"
            });
            var validation = await response.json().catch(function () {
              return {};
            });
            if (validationGeneration !== state.authGeneration) return false;
            if (!response.ok) return false;
            applyCookieAuthSession(validation, false);
            state.authenticated = true;
            showAuthenticatedApp();
            await loadTemplates();
            warmInsertionDependencies();
            return true;
          } catch (error) {
            if (validationGeneration !== state.authGeneration) return false;
            return false;
          }
        }

        async function establishCookieAuthenticationAndLoad() {
          var session = currentAuthSession();
          if (!session || state.authMode !== "bearer") {
            throw new Error("Sign in to FC Uno to continue.");
          }
          var generation = state.authGeneration;
          var response = await fetch(AUTH_DIALOG_URL, {
            method: "POST",
            cache: "no-store",
            credentials: "include",
            headers: {
              Authorization: "Bearer " + session.token,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ action: "establish-taskpane-session" })
          });
          var validation = await response.json().catch(function () {
            return {};
          });
          if (generation !== state.authGeneration ||
              state.authMode !== "bearer" ||
              state.authSession !== session) {
            throw new Error("The FC Uno sign-in changed while loading data.");
          }
          if (!response.ok) {
            throw new Error(
              validation.message || "FC Uno could not keep this sign-in."
            );
          }
          applyCookieAuthSession(validation, false);
          state.authenticated = true;
          showAuthenticatedApp();
          await loadTemplates();
          warmInsertionDependencies();
        }

        function acceptDialogMessage(event) {
          try {
            var message = JSON.parse(String(event && event.message || ""));
            storeAuthSession(message);
            closeAuthDialog();
            establishCookieAuthenticationAndLoad().catch(function (error) {
              if (!state.authSession) return;
              if (state.authMode === "bearer") {
                validateAuthenticationAndLoad();
                return;
              }
              state.authenticated = false;
              showAuthenticationState(
                error && error.message
                  ? error.message
                  : "FC Uno could not keep this sign-in.",
                false
              );
            });
          } catch (error) {
            closeAuthDialog();
            clearAuthentication(
              error && error.message
                ? error.message
                : "FC Uno returned an invalid sign-in response.",
              false
            );
          }
        }

        function openAuthDialog() {
          if (state.authDialog) return;
          var office = window.Office;
          if (!office ||
              !office.context ||
              !office.context.ui ||
              typeof office.context.ui.displayDialogAsync !== "function") {
            showAuthenticationState(
              "This Outlook client does not support the secure FC Uno sign-in dialog.",
              false
            );
            return;
          }

          els.signInButton.disabled = true;
          els.authMessage.textContent = "";
          office.context.ui.displayDialogAsync(
            AUTH_DIALOG_URL,
            { height: 68, width: 42, displayInIframe: false },
            function (result) {
              if (!result ||
                  result.status !== office.AsyncResultStatus.Succeeded ||
                  !result.value) {
                state.authDialog = null;
                els.signInButton.disabled = false;
                showAuthenticationState(
                  result && result.error && result.error.message
                    ? result.error.message
                    : "Outlook could not open the secure sign-in dialog.",
                  false
                );
                return;
              }
              state.authDialog = result.value;
              state.authDialog.addEventHandler(
                office.EventType.DialogMessageReceived,
                acceptDialogMessage
              );
              state.authDialog.addEventHandler(
                office.EventType.DialogEventReceived,
                function (event) {
                  var errorCode = Number(event && event.error || 0);
                  closeAuthDialog();
                  if (!state.authenticated && errorCode !== 12006) {
                    showAuthenticationState(
                      "The FC Uno sign-in dialog closed before authentication completed.",
                      false
                    );
                  }
                }
              );
            }
          );
        }

        function normaliseTemplate(input) {
          return {
            id: String(input && input.id || ""),
            title: String(input && input.title || "Untitled template"),
            subject: String(input && input.subject || ""),
            folder: String(input && input.folder || "Unfiled"),
            to: String(input && input.to || ""),
            cc: String(input && input.cc || ""),
            bcc: String(input && input.bcc || ""),
            bodyHtml: String(input && input.bodyHtml || "<p></p>"),
            bodyText: String(input && input.bodyText || ""),
            updatedAt: String(input && input.updatedAt || ""),
            revision: Number(input && input.revision || 0),
            recipientResolution: input && input.recipientResolution && typeof input.recipientResolution === "object"
              ? input.recipientResolution
              : null
          };
        }

        function stripOuterQuotes(value) {
          return String(value || "").trim().replace(/^"+|"+$/g, "");
        }

        function splitRecipientText(value) {
          var text = String(value || "").replace(/\\r?\\n/g, " ");
          var parts = [];
          var current = "";
          var inQuote = false;
          var angleDepth = 0;

          for (var i = 0; i < text.length; i += 1) {
            var char = text.charAt(i);
            if (char === '"' && text.charAt(i - 1) !== "\\\\") inQuote = !inQuote;
            if (!inQuote && char === "<") angleDepth += 1;
            if (!inQuote && char === ">" && angleDepth > 0) angleDepth -= 1;
            if (!inQuote && angleDepth === 0 && (char === "," || char === ";")) {
              if (current.trim()) parts.push(current.trim());
              current = "";
              continue;
            }
            current += char;
          }
          if (current.trim()) parts.push(current.trim());
          return parts;
        }

        function compactRecipients(value) {
          var parts = splitRecipientText(value)
            .map(function (part) {
              var bracket = part.match(/^(.*?)<([^>]+)>$/);
              var label = bracket ? stripOuterQuotes(bracket[1]) : stripOuterQuotes(part);
              return label || (bracket ? stripOuterQuotes(bracket[2]) : stripOuterQuotes(part));
            })
            .filter(Boolean)
            .slice(0, 2);
          return parts.join(", ");
        }

        function recipientSummary(template) {
          if (template.to) return "To: " + compactRecipients(template.to);
          if (template.cc) return "Cc: " + compactRecipients(template.cc);
          if (template.bcc) return "Bcc: " + compactRecipients(template.bcc);
          return "-";
        }

        function folderParts(folder) {
          return String(folder || "Unfiled").split(" / ").map(function (part) {
            return part.trim();
          }).filter(Boolean);
        }

        function createFolderNode(name, path, depth) {
          return { name: name, path: path, depth: depth, children: [], templates: [], totalCount: 0 };
        }

        function buildFolderTree(templates) {
          var root = createFolderNode("All templates", "", 0);
          var index = { "": root };

          templates.forEach(function (template) {
            var node = root;
            folderParts(template.folder).forEach(function (part, partIndex) {
              var nextPath = node.path ? node.path + " / " + part : part;
              if (!index[nextPath]) {
                index[nextPath] = createFolderNode(part, nextPath, partIndex + 1);
                node.children.push(index[nextPath]);
              }
              node = index[nextPath];
            });
            node.templates.push(template);
          });

          function sortAndCount(node) {
            node.children.sort(function (a, b) { return a.name.localeCompare(b.name); });
            node.templates.sort(function (a, b) { return a.title.localeCompare(b.title); });
            node.totalCount = node.templates.length + node.children.reduce(function (sum, child) {
              return sum + sortAndCount(child);
            }, 0);
            return node.totalCount;
          }

          sortAndCount(root);
          return { root: root, index: index };
        }

        function folderContains(template, folder) {
          if (!folder) return true;
          return template.folder === folder || template.folder.indexOf(folder + " / ") === 0;
        }

        function normaliseSearchText(value) {
          return String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim();
        }

        function matchesQuery(template, query) {
          var tokens = normaliseSearchText(query).split(" ").filter(Boolean);
          if (!tokens.length) return true;
          var haystack = normaliseSearchText([template.title, template.subject, template.folder, template.to, template.cc, template.bcc].join(" "));
          return tokens.every(function (token) { return haystack.indexOf(token) !== -1; });
        }

        function visibleTemplates() {
          var query = state.query.trim();
          return state.templates.filter(function (template) {
            return matchesQuery(template, query) && folderContains(template, state.selectedFolder);
          });
        }

        function expandPath(path) {
          state.expanded[""] = true;
          var cursor = "";
          folderParts(path).forEach(function (part) {
            cursor = cursor ? cursor + " / " + part : part;
            state.expanded[cursor] = true;
          });
        }

        function chooseInitialFolder() {
          var preferred = ["Outgoing / Bunker", "Internal / Outgoing / Bunker", "Outgoing / Account", "FCBV"];
          for (var i = 0; i < preferred.length; i += 1) {
            if (state.folderIndex[preferred[i]]) return preferred[i];
          }
          return Object.keys(state.folderIndex).find(function (path) { return path; }) || "";
        }

        function renderFolderNode(node) {
          var container = document.createElement("div");
          var row = document.createElement("button");
          var arrow = document.createElement("span");
          var name = document.createElement("span");
          var hasChildren = node.children.length > 0;

          container.className = "folderNode";
          row.type = "button";
          row.className = "folderRow" + (state.selectedFolder === node.path ? " active" : "");
          row.addEventListener("click", function () {
            state.selectedFolder = node.path;
            expandPath(node.path);
            var visible = visibleTemplates();
            state.selectedId = visible[0] ? visible[0].id : "";
            render();
          });

          arrow.className = "folderToggle";
          arrow.textContent = hasChildren ? (state.expanded[node.path] || state.query ? "-" : "+") : "";
          arrow.addEventListener("click", function (event) {
            event.stopPropagation();
            if (!hasChildren) return;
            state.expanded[node.path] = !state.expanded[node.path];
            renderFolders();
          });
          name.className = "folderName";
          name.textContent = node.name;
          row.appendChild(arrow);
          row.appendChild(name);
          container.appendChild(row);

          if (hasChildren && (state.expanded[node.path] || state.query)) {
            var children = document.createElement("div");
            children.className = "folderChildren";
            node.children.forEach(function (child) { children.appendChild(renderFolderNode(child)); });
            container.appendChild(children);
          }

          return container;
        }

        function renderFolders() {
          if (!state.folderRoot) return;
          var tree = state.query ? buildFolderTree(state.templates.filter(function (template) {
            return matchesQuery(template, state.query);
          })).root : state.folderRoot;
          els.folderTree.innerHTML = "";
          if (!tree.totalCount) {
            els.folderTree.innerHTML = '<div class="empty">No matching folders.</div>';
            return;
          }
          els.folderTree.appendChild(renderFolderNode(tree));
        }

        function renderTemplates() {
          var visible = visibleTemplates();
          if (!visible.some(function (template) { return template.id === state.selectedId; })) {
            state.selectedId = visible[0] ? visible[0].id : "";
          }

          els.listTitle.textContent = state.query ? "Search results" : (state.selectedFolder || "All templates");
          els.templateList.innerHTML = "";

          if (!visible.length) {
            els.templateList.innerHTML = '<div class="empty">No templates found.</div>';
            return;
          }

          var header = document.createElement("div");
          header.className = "templateGridHeader";
          header.innerHTML = "<span>Recipient</span><span>Subject</span>";
          els.templateList.appendChild(header);

          visible.forEach(function (template) {
            var row = document.createElement("button");
            var subject = template.subject || template.title || "Untitled template";
            row.type = "button";
            row.className = "templateRow" + (template.id === state.selectedId ? " active" : "");
            row.addEventListener("click", function () {
              state.selectedId = template.id;
              loadTemplateDetail(template.id, false).catch(function () {
                // The insertion path reports a fresh detail error if preloading fails.
              });
              renderTemplates();
            });
            row.addEventListener("dblclick", function () {
              state.selectedId = template.id;
              insertSelectedTemplate();
            });
            row.innerHTML =
              '<span class="recipient">' + escapeHtml(recipientSummary(template)) + '</span>' +
              '<span class="title">' + escapeHtml(subject) + '</span>';
            els.templateList.appendChild(row);
          });
        }

        function render() {
          renderFolders();
          renderTemplates();
        }

        function officeAsync(call) {
          return new Promise(function (resolve, reject) {
            call(function (result) {
              var office = window.Office;
              if (office && result && result.status === office.AsyncResultStatus.Succeeded) {
                resolve(result.value);
                return;
              }
              reject(new Error(result && result.error && result.error.message ? result.error.message : "Outlook action failed."));
            });
          });
        }

        function clearRecipientMap(removeStoredCache) {
          state.recipientsBySourceKey = {};
          state.recipientMapLoaded = false;
          state.recipientMapFromNetwork = false;
          state.recipientMapExpiresAt = 0;
          state.recipientCertification = null;
          state.recipientMapPromise = null;
          if (removeStoredCache === false) return;
          try {
            if (window.localStorage) window.localStorage.removeItem(RECIPIENT_MAP_CACHE_KEY);
          } catch (error) {
            return;
          }
        }

        function validCacheTime(cachedAt, expiresAt, maxTtlMs) {
          var now = Date.now();
          return Number.isFinite(cachedAt) &&
            Number.isFinite(expiresAt) &&
            cachedAt <= now + 30000 &&
            expiresAt > now &&
            expiresAt > cachedAt &&
            expiresAt - cachedAt <= maxTtlMs;
        }

        function networkPayloadTtlMs(data, maxTtlMs) {
          if (!data) return 0;
          var generatedAt = Date.parse(String(data.generatedAt || ""));
          var expiresAt = Date.parse(String(data.expiresAt || ""));
          var ttlSeconds = Number(data.ttlSeconds);
          if (!Number.isSafeInteger(ttlSeconds) ||
              ttlSeconds < 1 ||
              !Number.isFinite(generatedAt) ||
              !Number.isFinite(expiresAt)) {
            return 0;
          }
          var advertisedTtlMs = ttlSeconds * 1000;
          var serverDurationMs = expiresAt - generatedAt;
          if (advertisedTtlMs > maxTtlMs ||
              serverDurationMs !== advertisedTtlMs) {
            return 0;
          }
          return advertisedTtlMs;
        }

        function applyRecipientMap(data, localExpiresAt) {
          var certification = data && data.certification;
          var fingerprint = String(certification && certification.sourceFingerprint || "").trim().toLowerCase();
          var projectionFingerprint = String(certification && certification.projectionSnapshotSha256 || "").trim().toLowerCase();
          if (!data ||
              data.schema !== "fcuno.outlook-certified-recipient-map/v2" ||
              !data.recipientsBySourceKey ||
              typeof data.recipientsBySourceKey !== "object" ||
              !certification ||
              String(certification.runId || "").trim() === "" ||
              !Number.isFinite(Date.parse(String(certification.certifiedAt || ""))) ||
              !/^[0-9a-f]{64}$/.test(fingerprint) ||
              projectionFingerprint !== fingerprint) {
            throw new Error("Certified recipient map response is invalid.");
          }
          var generatedAt = Date.parse(String(data.generatedAt || ""));
          var certifiedAt = Date.parse(String(certification.certifiedAt || ""));
          var maxCertificationAgeSeconds = Number(certification.maxAgeSeconds);
          if (networkPayloadTtlMs(data, 5 * 60 * 1000) === 0 ||
              !Number.isFinite(localExpiresAt) ||
              localExpiresAt <= Date.now() ||
              !Number.isSafeInteger(maxCertificationAgeSeconds) ||
              maxCertificationAgeSeconds < 120 ||
              maxCertificationAgeSeconds > 7 * 24 * 60 * 60 ||
              generatedAt - certifiedAt < -5 * 60 * 1000 ||
              generatedAt - certifiedAt > maxCertificationAgeSeconds * 1000) {
            throw new Error("Certified recipient map is expired.");
          }
          var recipientKeys = Object.keys(data.recipientsBySourceKey);
          var counts = data.counts || {};
          var contactCount = 0;
          var groupCount = 0;
          recipientKeys.forEach(function (sourceKey) {
            var entry = data.recipientsBySourceKey[sourceKey];
            if (!entry ||
                (entry.kind !== "contact" && entry.kind !== "group") ||
                sourceKey !== entry.kind + ":" + String(entry.sourceId || "") ||
                !/^[^@\\s]+@[^@\\s]+$/.test(String(entry.emailAddress || ""))) {
              throw new Error("Certified recipient map contains an invalid stable identity.");
            }
            if (entry.kind === "contact") contactCount += 1;
            if (entry.kind === "group") groupCount += 1;
          });
          if (!Number.isSafeInteger(Number(counts.contacts)) ||
              !Number.isSafeInteger(Number(counts.groups)) ||
              !Number.isSafeInteger(Number(counts.mappedSourceIds)) ||
              Number(counts.contacts) !== contactCount ||
              Number(counts.groups) !== groupCount ||
              Number(counts.mappedSourceIds) !== recipientKeys.length) {
            throw new Error("Certified recipient map counts are inconsistent.");
          }
          state.recipientsBySourceKey = data.recipientsBySourceKey;
          state.recipientMapLoaded = true;
          state.recipientMapExpiresAt = localExpiresAt;
          state.recipientCertification = data.certification;
        }

        function loadCachedRecipientMap() {
          try {
            var cached = window.localStorage && window.localStorage.getItem(RECIPIENT_MAP_CACHE_KEY);
            if (!cached) return false;
            var envelope = JSON.parse(cached);
            if (!envelope ||
                envelope.schema !== RECIPIENT_CACHE_SCHEMA ||
                !validCacheTime(Number(envelope.cachedAt), Number(envelope.expiresAt), 5 * 60 * 1000)) {
              clearRecipientMap();
              return false;
            }
            applyRecipientMap(envelope.data, Number(envelope.expiresAt));
            state.recipientMapFromNetwork = false;
            return true;
          } catch (error) {
            clearRecipientMap();
            return false;
          }
        }

        function saveCachedRecipientMap(data, cachedAt, expiresAt) {
          try {
            if (!window.localStorage ||
                !validCacheTime(cachedAt, expiresAt, 5 * 60 * 1000)) return;
            window.localStorage.setItem(RECIPIENT_MAP_CACHE_KEY, JSON.stringify({
              schema: RECIPIENT_CACHE_SCHEMA,
              cachedAt: cachedAt,
              expiresAt: expiresAt,
              data: data
            }));
          } catch (error) {
            return;
          }
        }

        async function loadRecipientMap(requireNetwork) {
          if (!state.authenticated) {
            throw new Error("Sign in to FC Uno before loading recipients.");
          }
          var fresh = state.recipientMapLoaded && state.recipientMapExpiresAt > Date.now();
          if (fresh && (!requireNetwork || state.recipientMapFromNetwork)) {
            return state.recipientsBySourceKey;
          }
          if (state.recipientMapPromise) return state.recipientMapPromise;

          if (!state.recipientMapLoaded) loadCachedRecipientMap();
          if (!requireNetwork && state.recipientMapLoaded && state.recipientMapExpiresAt > Date.now()) {
            return state.recipientsBySourceKey;
          }

          var requestGeneration = state.authGeneration;
          var recipientRequest = (async function () {
            var result = await authenticatedFetch(RECIPIENT_MAP_URL);
            if (!result.response.ok) {
              throw new Error("The certified recipient map is unavailable.");
            }
            var data = await result.response.json();
            assertAuthRequestCurrent(result.context);
            if (!state.authenticated) {
              throw new Error("Sign in to FC Uno before loading recipients.");
            }
            var receivedAt = Date.now();
            var ttlMs = networkPayloadTtlMs(data, 5 * 60 * 1000);
            if (ttlMs === 0) {
              throw new Error("Certified recipient map response has an invalid lifetime.");
            }
            var localExpiresAt = receivedAt + ttlMs;
            applyRecipientMap(data, localExpiresAt);
            state.recipientMapFromNetwork = true;
            saveCachedRecipientMap(data, receivedAt, localExpiresAt);
            return state.recipientsBySourceKey;
          })()
            .catch(function (error) {
              if (requestGeneration === state.authGeneration) {
                clearRecipientMap();
              }
              throw error;
            })
            .finally(function () {
              if (state.recipientMapPromise === recipientRequest) {
                state.recipientMapPromise = null;
              }
            });

          state.recipientMapPromise = recipientRequest;
          return recipientRequest;
        }

        function addParsedRecipient(recipients, seen, recipient) {
          if (!recipient || !recipient.emailAddress) return;
          var key = String(recipient.emailAddress).toLowerCase();
          if (!key || seen[key]) return;
          seen[key] = true;
          recipients.push(recipient);
        }

        function resolveStoredRecipientRefs(template, field) {
          if (!state.recipientMapLoaded ||
              !state.recipientMapFromNetwork ||
              state.recipientMapExpiresAt <= Date.now()) {
            throw new Error("A current certified recipient map is required.");
          }
          var resolution = template && template.recipientResolution;
          var counts = resolution && resolution.counts;
          if (!resolution ||
              resolution.schema !== "fcuno.outlook-template-recipient-resolution/v1" ||
              (Object.prototype.hasOwnProperty.call(
                resolution,
                "reconciliationRequired"
              ) && resolution.reconciliationRequired !== false) ||
              String(resolution.certificationRunId || "").trim() === "" ||
              !Number.isFinite(Date.parse(String(resolution.certifiedAt || ""))) ||
              !Number.isFinite(Date.parse(String(resolution.resolvedAt || ""))) ||
              String(resolution.sourceFingerprint || "").trim().toLowerCase() !==
                String(state.recipientCertification && state.recipientCertification.sourceFingerprint || "").trim().toLowerCase() ||
              !resolution.refs ||
              !Array.isArray(resolution.refs.to) ||
              !Array.isArray(resolution.refs.cc) ||
              !Array.isArray(resolution.refs.bcc) ||
              !Array.isArray(resolution.refs[field]) ||
              !counts ||
              !Number.isSafeInteger(Number(counts.total)) ||
              !Number.isSafeInteger(Number(counts.resolved)) ||
              !Number.isSafeInteger(Number(counts.external)) ||
              !Number.isSafeInteger(Number(counts.ambiguous)) ||
              !Number.isSafeInteger(Number(counts.missing)) ||
              Number(counts.total) < 0 ||
              Number(counts.resolved) < 0 ||
              Number(counts.external) < 0 ||
              Number(counts.ambiguous) !== 0 ||
              Number(counts.missing) !== 0 ||
              Number(counts.total) !==
                resolution.refs.to.length + resolution.refs.cc.length + resolution.refs.bcc.length ||
              Number(counts.total) !== Number(counts.resolved) + Number(counts.external)) {
            throw new Error("This template is not resolved against the current certified address book. Re-save it in FC Uno before inserting.");
          }

          var sourceText = String(template[field] || "");
          var literals = splitRecipientText(sourceText);
          var refs = resolution.refs[field];
          if (refs.length !== literals.length) {
            throw new Error("Stored recipient evidence does not match the current template.");
          }

          var recipients = [];
          var seen = {};
          refs.forEach(function (ref, index) {
            if (!ref ||
                ref.field !== field ||
                Number(ref.position) !== index ||
                String(ref.literal || "").trim() !== String(literals[index] || "").trim()) {
              throw new Error("Stored recipient evidence is inconsistent.");
            }
            if (ref.status === "resolved" && (ref.kind === "contact" || ref.kind === "group") && ref.sourceId) {
              var sourceKey = ref.kind + ":" + String(ref.sourceId);
              var current = state.recipientsBySourceKey[sourceKey];
              if (!current ||
                  current.kind !== ref.kind ||
                  String(current.sourceId) !== String(ref.sourceId) ||
                  !current.emailAddress) {
                throw new Error("A certified recipient is no longer present in the current Exchange projection.");
              }
              addParsedRecipient(recipients, seen, {
                displayName: current.displayName || current.emailAddress,
                emailAddress: current.emailAddress
              });
              return;
            }
            if (ref.status === "external" && ref.kind === "external" &&
                /^[^@\\s]+@[^@\\s]+$/.test(String(ref.resolvedAddress || ""))) {
              addParsedRecipient(recipients, seen, {
                displayName: ref.displayName || ref.resolvedAddress,
                emailAddress: String(ref.resolvedAddress).toLowerCase()
              });
              return;
            }
            throw new Error("This template contains an unresolved, ambiguous or missing recipient.");
          });
          return recipients;
        }

        function validApiPayloadTime(data, maxTtlMs) {
          return networkPayloadTtlMs(data, maxTtlMs) > 0;
        }

        function templateDetailCacheKey(template) {
          return [
            String(template && template.id || ""),
            String(template && template.revision || ""),
            String(template && template.updatedAt || "")
          ].join(":");
        }

        async function loadTemplateDetail(id, forceRefresh) {
          if (!id) return null;
          if (!state.authenticated) {
            throw new Error("Sign in to FC Uno before loading a template.");
          }
          var indexTemplate = state.templates.find(function (template) { return template.id === id; }) || null;
          var cacheKey = templateDetailCacheKey(indexTemplate || { id: id });
          if (!forceRefresh && state.detailCache[cacheKey]) return state.detailCache[cacheKey];

          var result = await authenticatedFetch(
            TEMPLATE_DETAIL_URL + "?id=" + encodeURIComponent(id)
          );
          if (result.response.status === 404) {
            throw new Error("This template is no longer available.");
          }
          if (!result.response.ok) {
            throw new Error("The current template could not be loaded.");
          }
          var data = await result.response.json();
          assertAuthRequestCurrent(result.context);
          if (!state.authenticated) {
            throw new Error("Sign in to FC Uno before loading a template.");
          }
          if (data.schema !== "fcuno.outlook-template-detail/v2" ||
              !validApiPayloadTime(data, INDEX_CACHE_TTL_MS)) {
            throw new Error("The template response is expired or invalid.");
          }
          var template = normaliseTemplate(Object.assign({}, indexTemplate || {}, data.template || {}));
          if (template.id !== id ||
              !Number.isSafeInteger(template.revision) ||
              template.revision < 1 ||
              !template.updatedAt) {
            throw new Error("The template revision is invalid.");
          }
          state.detailCache[templateDetailCacheKey(template)] = template;
          return template;
        }

        function createOperationId() {
          var cryptoApi = window.crypto;
          if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
            return cryptoApi.randomUUID().toLowerCase();
          }
          if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
            throw new Error("This Outlook client cannot create a secure insertion operation identifier.");
          }
          var bytes = new Uint8Array(16);
          cryptoApi.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          var hex = Array.prototype.map.call(bytes, function (value) {
            return value.toString(16).padStart(2, "0");
          }).join("");
          return [
            hex.slice(0, 8),
            hex.slice(8, 12),
            hex.slice(12, 16),
            hex.slice(16, 20),
            hex.slice(20)
          ].join("-");
        }

        function waitForRetry(delayMs) {
          return new Promise(function (resolve) {
            window.setTimeout(resolve, delayMs);
          });
        }

        function createInsertionAuditContext(template, operationId) {
          var certification = state.recipientCertification || {};
          var certificationRunId = String(
            certification.runId || ""
          ).trim().toLowerCase();
          var sourceFingerprint = String(
            certification.sourceFingerprint || ""
          ).trim().toLowerCase();
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              certificationRunId
            ) ||
            !/^[0-9a-f]{64}$/.test(sourceFingerprint) ||
            !Number.isSafeInteger(Number(template.revision)) ||
            Number(template.revision) < 1
          ) {
            throw new Error(
              "The current Exchange certification cannot be attached to this insertion."
            );
          }
          return {
            operationId: operationId,
            templateId: template.id,
            templateRevision: template.revision,
            certificationRunId: certificationRunId,
            sourceFingerprint: sourceFingerprint,
            authGeneration: state.authGeneration
          };
        }

        async function recordInsertionAuditEvent(auditContext, phase, outcome) {
          var auditGeneration = auditContext.authGeneration;
          var retryDelays = [250, 700];
          var lastError = null;
          for (var attempt = 0; attempt < 3; attempt += 1) {
            if (auditGeneration !== state.authGeneration) {
              throw new Error("The FC Uno sign-in changed before the insertion attempt could be audited.");
            }
            try {
              var auditPayload = {
                phase: phase,
                operationId: auditContext.operationId,
                templateId: auditContext.templateId,
                templateRevision: auditContext.templateRevision,
                certificationRunId: auditContext.certificationRunId,
                sourceFingerprint: auditContext.sourceFingerprint
              };
              if (phase === "terminal") auditPayload.outcome = outcome;
              var result = await authenticatedFetch(INSERTION_AUDIT_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(auditPayload)
              });
              if (result.response.ok) {
                assertAuthRequestCurrent(result.context);
                if (
                  result.response.headers.get(
                    "X-Outlook-Insertion-Audit-Phase"
                  ) !== phase
                ) {
                  lastError = new Error(
                    "FC Uno returned an invalid insertion audit acknowledgement."
                  );
                  lastError.auditRetryable = false;
                  throw lastError;
                }
                return;
              }
              var errorData = await result.response.json().catch(function () {
                return {};
              });
              assertAuthRequestCurrent(result.context);
              var retryable =
                errorData.code === "INSERT_RESERVATION_BUSY" ||
                result.response.status === 429 ||
                result.response.status >= 500;
              lastError = new Error(
                errorData.message || "The insertion attempt audit could not be recorded."
              );
              lastError.auditRetryable = retryable;
              if (!retryable || attempt >= retryDelays.length) throw lastError;
            } catch (error) {
              lastError = error instanceof Error
                ? error
                : new Error("The insertion attempt audit could not be recorded.");
              if (lastError.auditRetryable === false ||
                  !state.authenticated ||
                  auditGeneration !== state.authGeneration ||
                  attempt >= retryDelays.length) {
                throw lastError;
              }
            }
            await waitForRetry(retryDelays[attempt]);
          }
          throw lastError || new Error("The insertion attempt audit could not be recorded.");
        }

        function graphRecipient(recipient) {
          var address = String(recipient && recipient.emailAddress || "").trim().toLowerCase();
          if (!/^[^@\\s]+@[^@\\s]+$/.test(address)) {
            throw new Error("A certified recipient has an invalid email address.");
          }
          return {
            emailAddress: {
              address: address,
              name: String(recipient && recipient.displayName || address).trim() || address
            }
          };
        }

        function buildGraphDraftPayload(template, toRecipients, ccRecipients, bccRecipients) {
          return {
            subject: String(template && template.subject || ""),
            body: {
              contentType: "HTML",
              content: String(template && template.bodyHtml || "<p></p>")
            },
            toRecipients: toRecipients.map(graphRecipient),
            ccRecipients: ccRecipients.map(graphRecipient),
            bccRecipients: bccRecipients.map(graphRecipient)
          };
        }

        function mailboxLoginHint() {
          var mailbox = window.Office && window.Office.context && window.Office.context.mailbox;
          return String(
            mailbox && mailbox.userProfile && mailbox.userProfile.emailAddress || ""
          ).trim().toLowerCase();
        }

        async function loadMsalBrowser() {
          if (window.msal &&
              typeof window.msal.createNestablePublicClientApplication === "function") {
            return window.msal;
          }
          if (state.msalScriptPromise) return state.msalScriptPromise;
          var scriptPromise = new Promise(function (resolve, reject) {
            var script = document.createElement("script");
            script.src = MSAL_SCRIPT_URL;
            script.async = true;
            script.onload = function () {
              if (window.msal &&
                  typeof window.msal.createNestablePublicClientApplication === "function") {
                resolve(window.msal);
                return;
              }
              reject(new Error("Secure Outlook new-message access could not be loaded."));
            };
            script.onerror = function () {
              reject(new Error("Secure Outlook new-message access could not be loaded."));
            };
            document.head.appendChild(script);
          }).catch(function (error) {
            if (state.msalScriptPromise === scriptPromise) {
              state.msalScriptPromise = null;
            }
            throw error;
          });
          state.msalScriptPromise = scriptPromise;
          return scriptPromise;
        }

        async function ensureGraphClient() {
          if (state.graphClientPromise) return state.graphClientPromise;
          var office = window.Office;
          var requirements = office && office.context && office.context.requirements;
          var supportsNestedAuth = Boolean(
            requirements &&
            typeof requirements.isSetSupported === "function" &&
            requirements.isSetSupported("NestedAppAuth", "1.1")
          );
          if (!supportsNestedAuth) {
            throw new Error(
              "This Outlook version does not support secure new-message sign-in. Update Outlook and try again."
            );
          }
          if (!NAA_CLIENT_ID || !NAA_AUTHORITY) {
            throw new Error("Secure Outlook new-message access is not configured.");
          }
          await loadMsalBrowser();
          if (!window.msal ||
              typeof window.msal.createNestablePublicClientApplication !== "function") {
            throw new Error("Secure Outlook new-message access could not be loaded.");
          }
          var graphClientPromise = window.msal.createNestablePublicClientApplication({
            auth: {
              clientId: NAA_CLIENT_ID,
              authority: NAA_AUTHORITY,
              supportsNestedAppAuth: true,
              clientCapabilities: ["CP1"]
            },
            cache: { cacheLocation: "localStorage" }
          }).catch(function (error) {
            if (state.graphClientPromise === graphClientPromise) {
              state.graphClientPromise = null;
            }
            throw error;
          });
          state.graphClientPromise = graphClientPromise;
          return graphClientPromise;
        }

        function warmInsertionDependencies() {
          loadRecipientMap(true).catch(function () {
            // A click retries and reports any current certification problem.
          });
          ensureGraphClient().catch(function () {
            // A click retries and reports any current Microsoft auth problem.
          });
        }

        function graphAccountMatchesMailbox(account) {
          var mailboxAddress = mailboxLoginHint();
          var accountAddress = String(account && account.username || "").trim().toLowerCase();
          return Boolean(mailboxAddress && accountAddress && mailboxAddress === accountAddress);
        }

        async function acquireGraphAccessToken() {
          var client = await ensureGraphClient();
          var loginHint = mailboxLoginHint();
          if (!loginHint) {
            throw new Error("Outlook did not provide the signed-in mailbox identity.");
          }
          var account = typeof client.getActiveAccount === "function"
            ? client.getActiveAccount()
            : null;
          if (!graphAccountMatchesMailbox(account) &&
              typeof client.getAccount === "function") {
            account = client.getAccount({ loginHint: loginHint });
          }
          var request = {
            scopes: GRAPH_SCOPES.slice(),
            loginHint: loginHint
          };
          if (graphAccountMatchesMailbox(account)) request.account = account;
          var result;
          try {
            result = await client.acquireTokenSilent(request);
          } catch (silentError) {
            result = await client.acquireTokenPopup(request);
          }
          if (!result || !result.accessToken || !graphAccountMatchesMailbox(result.account)) {
            throw new Error(
              "Microsoft signed in a different mailbox. Select " + loginHint + " and try again."
            );
          }
          if (typeof client.setActiveAccount === "function") {
            client.setActiveAccount(result.account);
          }
          return result.accessToken;
        }

        async function readGraphError(response, fallback) {
          var data = await response.json().catch(function () { return {}; });
          return new Error(
            data && data.error && data.error.message
              ? String(data.error.message)
              : fallback
          );
        }

        async function createGraphDraft(accessToken, payload) {
          var response = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + accessToken,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            throw await readGraphError(response, "Microsoft Graph could not create the new draft.");
          }
          var draft = await response.json();
          if (!draft || !draft.id || draft.isDraft !== true || !draft.webLink) {
            throw new Error("Microsoft Graph returned an invalid new draft.");
          }
          return draft;
        }

        async function deleteGraphDraft(accessToken, draftId) {
          if (!accessToken || !draftId) return false;
          var response = await fetch(
            "https://graph.microsoft.com/v1.0/me/messages/" + encodeURIComponent(draftId),
            {
              method: "DELETE",
              headers: { Authorization: "Bearer " + accessToken }
            }
          );
          return response.ok;
        }

        function reserveNewMessageWindow() {
          var popup = window.open(
            "about:blank",
            "_blank",
            "popup=yes,width=1180,height=860,resizable=yes,scrollbars=yes"
          );
          if (!popup) {
            throw new Error(
              "Outlook blocked the new message window. Allow pop-ups for Outlook and try again."
            );
          }
          try {
            popup.document.title = "Preparing Outlook message";
            popup.document.body.style.cssText =
              "margin:0;display:grid;min-height:100vh;place-items:center;" +
              "background:#f4f6f8;color:#172534;font:600 15px Roboto,Arial,sans-serif";
            popup.document.body.textContent = "Preparing your Outlook message...";
          } catch (error) {
            // The reserved window can still be navigated if its placeholder cannot be styled.
          }
          return popup;
        }

        function closeReservedNewMessageWindow(popup) {
          if (!popup || popup.closed) return;
          try {
            popup.close();
          } catch (error) {
            // The browser may already have released the placeholder window.
          }
        }

        function trustedOutlookDraftWebLink(draft) {
          var parsed;
          try {
            parsed = new URL(String(draft && draft.webLink || ""));
          } catch (error) {
            throw new Error("Microsoft Graph returned an invalid Outlook message link.");
          }
          var hostname = parsed.hostname.toLowerCase();
          var trustedHosts = [
            "outlook.office.com",
            "outlook.office365.com",
            "outlook.cloud.microsoft"
          ];
          var trusted = trustedHosts.some(function (host) {
            return hostname === host || hostname.endsWith("." + host);
          });
          if (parsed.protocol !== "https:" || !trusted) {
            throw new Error("Microsoft Graph returned an untrusted Outlook message link.");
          }
          parsed.searchParams.set("ispopout", "1");
          return parsed.toString();
        }

        function openGraphDraftInReservedWindow(popup, draft) {
          if (!popup || popup.closed) {
            throw new Error(
              "The new Outlook message window was closed before loading completed."
            );
          }
          popup.location.replace(trustedOutlookDraftWebLink(draft));
        }

        async function insertSelectedTemplate() {
          if (!state.selectedId) return;
          if (state.inserting) {
            notice("A template insertion is already in progress.", "");
            return;
          }

          var composeWindow;
          try {
            composeWindow = reserveNewMessageWindow();
          } catch (error) {
            notice(
              error && error.message
                ? error.message
                : "Outlook could not open a new message window.",
              "error"
            );
            return;
          }
          state.inserting = true;
          notice("Preparing template and certified recipients...", "");
          var graphDraft = null;
          var graphAccessToken = "";
          var mutationStarted = false;
          var mutationCompleted = false;
          var reservationRecorded = false;
          var auditContext = null;
          try {
            var prepared = await Promise.all([
              loadTemplateDetail(state.selectedId, false),
              loadRecipientMap(true),
              acquireGraphAccessToken()
            ]);
            var template = prepared[0];
            graphAccessToken = prepared[2];
            if (!template) throw new Error("Template not found.");
            var toRecipients = resolveStoredRecipientRefs(template, "to");
            var ccRecipients = resolveStoredRecipientRefs(template, "cc");
            var bccRecipients = resolveStoredRecipientRefs(template, "bcc");
            if (
              !state.recipientMapFromNetwork ||
              state.recipientMapExpiresAt <= Date.now()
            ) {
              throw new Error(
                "The certified recipient map expired before the new draft was created. Try again."
              );
            }

            var operationId = createOperationId();
            auditContext = createInsertionAuditContext(template, operationId);
            notice("Reserving certified insertion...", "");
            await recordInsertionAuditEvent(
              auditContext,
              "reserved",
              null
            );
            reservationRecorded = true;
            notice("Creating a new Outlook message...", "");
            graphDraft = await createGraphDraft(
              graphAccessToken,
              buildGraphDraftPayload(
                template,
                toRecipients,
                ccRecipients,
                bccRecipients
              )
            );
            mutationStarted = true;
            openGraphDraftInReservedWindow(composeWindow, graphDraft);
            mutationCompleted = true;
            try {
              await recordInsertionAuditEvent(
                auditContext,
                "terminal",
                "inserted"
              );
            } catch (auditError) {
              notice(
                "The new Outlook message opened, but FC Uno could not confirm the terminal audit record. " +
                  "The reserved audit entry remains visible for review; do not open this template again.",
                "error"
              );
              return;
            }
            notice("New message opened. Original draft unchanged. Audit completed.", "success");
          } catch (error) {
            if (mutationCompleted) {
              notice(
                (error && error.message ? error.message : "Audit finalization failed.") +
                  " The new Outlook message remains open and its reserved audit entry remains visible for review.",
                "error"
              );
              return;
            }
            closeReservedNewMessageWindow(composeWindow);
            var outcome = "failed-preserved";
            var recoveryMessage = " The original Outlook draft was not changed.";
            if (mutationStarted && graphDraft && graphAccessToken) {
              try {
                var removed = await deleteGraphDraft(
                  graphAccessToken,
                  graphDraft.id
                );
                recoveryMessage = removed
                  ? " The unopened new draft was removed; the original Outlook draft was not changed."
                  : " The original Outlook draft was not changed, but the unopened new draft could not be removed automatically.";
              } catch (cleanupError) {
                recoveryMessage =
                  " The original Outlook draft was not changed, but the unopened new draft could not be removed automatically.";
              }
            }
            var auditMessage = "";
            if (reservationRecorded && auditContext) {
              try {
                await recordInsertionAuditEvent(
                  auditContext,
                  "terminal",
                  outcome
                );
                auditMessage = " Audit completed as " + outcome + ".";
              } catch (auditError) {
                auditMessage =
                  " The reserved audit entry remains incomplete and visible for review.";
              }
            }
            notice(
              (error && error.message ? error.message : "Insert failed.") +
                recoveryMessage +
                auditMessage,
              "error"
            );
          } finally {
            state.inserting = false;
            if (!mutationCompleted) {
              closeReservedNewMessageWindow(composeWindow);
            }
          }
        }

        async function loadTemplates() {
          if (!state.authenticated) {
            throw new Error("Sign in to FC Uno to load Outlook Templates.");
          }
          function applyTemplateIndex(data, keepSelection) {
            var previousFolder = state.selectedFolder;
            var previousId = state.selectedId;
            state.templates = Array.isArray(data.templates) ? data.templates.map(normaliseTemplate) : [];
            state.templates.sort(function (a, b) { return a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title); });
            var built = buildFolderTree(state.templates);
            state.folderRoot = built.root;
            state.folderIndex = built.index;
            if (keepSelection && state.folderIndex[previousFolder]) {
              state.selectedFolder = previousFolder;
            } else {
              state.selectedFolder = chooseInitialFolder();
            }
            expandPath(state.selectedFolder);
            var visible = visibleTemplates();
            state.selectedId = keepSelection && visible.some(function (template) { return template.id === previousId; })
              ? previousId
              : (visible[0] ? visible[0].id : "");
            render();
          }

          function loadCachedIndex() {
            try {
              var cached = window.localStorage && window.localStorage.getItem(INDEX_CACHE_KEY);
              if (!cached) return false;
              var envelope = JSON.parse(cached);
              if (!envelope ||
                  envelope.schema !== INDEX_CACHE_SCHEMA ||
                  !validCacheTime(Number(envelope.cachedAt), Number(envelope.expiresAt), INDEX_CACHE_TTL_MS) ||
                  !envelope.data ||
                  envelope.data.schema !== "fcuno.outlook-template-index/v2" ||
                  !Array.isArray(envelope.data.templates)) {
                if (window.localStorage) window.localStorage.removeItem(INDEX_CACHE_KEY);
                return false;
              }
              applyTemplateIndex(envelope.data, false);
              return true;
            } catch (error) {
              try {
                if (window.localStorage) window.localStorage.removeItem(INDEX_CACHE_KEY);
              } catch (storageError) {
                return false;
              }
              return false;
            }
          }

          function saveCachedIndex(data, cachedAt, expiresAt) {
            try {
              if (!window.localStorage ||
                  !validCacheTime(cachedAt, expiresAt, INDEX_CACHE_TTL_MS)) return;
              window.localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify({
                schema: INDEX_CACHE_SCHEMA,
                cachedAt: cachedAt,
                expiresAt: expiresAt,
                data: data
              }));
            } catch (error) {
              return;
            }
          }

          var templateLoadGeneration = state.authGeneration;
          var hadCache = loadCachedIndex();
          try {
            var result = await authenticatedFetch(TEMPLATE_INDEX_URL);
            if (!result.response.ok) {
              throw new Error("Outlook Templates are temporarily unavailable.");
            }
            var data = await result.response.json();
            assertAuthRequestCurrent(result.context);
            if (!state.authenticated) {
              throw new Error("Sign in to FC Uno to load Outlook Templates.");
            }
            if (data.schema !== "fcuno.outlook-template-index/v2" ||
                !Array.isArray(data.templates) ||
                !validApiPayloadTime(data, INDEX_CACHE_TTL_MS)) {
              throw new Error("The template index response is expired or invalid.");
            }
            var receivedAt = Date.now();
            var localExpiresAt =
              receivedAt + networkPayloadTtlMs(data, INDEX_CACHE_TTL_MS);
            saveCachedIndex(data, receivedAt, localExpiresAt);
            applyTemplateIndex(data, hadCache);
            notice("", "");
          } catch (error) {
            if (templateLoadGeneration !== state.authGeneration) return;
            if (!state.authenticated) return;
            if (!hadCache) {
              els.folderTree.innerHTML = '<div class="empty">Could not load folders.</div>';
              els.templateList.innerHTML = '<div class="empty">' + escapeHtml(error && error.message ? error.message : "Could not load templates.") + '</div>';
            } else {
              notice("Using saved template index. Refresh later for latest edits.", "error");
            }
          }
        }

        els.search.addEventListener("input", function () {
          if (!state.authenticated) return;
          state.query = els.search.value.trim();
          state.selectedFolder = "";
          state.selectedId = visibleTemplates()[0] ? visibleTemplates()[0].id : "";
          render();
        });

        els.signInButton.addEventListener("click", openAuthDialog);
        els.signOutButton.addEventListener("click", signOut);

        async function initialiseTaskpane() {
          clearConfidentialState(false);
          showAuthenticationState("Checking your FC Uno sign-in...", false);
          if (await validateCookieAuthenticationAndLoad()) return;
          var restored = restoreAuthSession();
          if (!restored) {
            clearAuthentication("", false);
            return;
          }
          state.authGeneration += 1;
          state.authenticated = false;
          state.authSession = restored;
          scheduleAuthExpiry(restored.expiresAt);
          showAuthenticationState("Checking your FC Uno sign-in...", false);
          validateAuthenticationAndLoad();
        }

        if (window.Office && typeof window.Office.onReady === "function") {
          window.Office.onReady(initialiseTaskpane);
        } else {
          initialiseTaskpane();
        }
      })();
    </script>
  </body>
</html>`

  return new NextResponse(html, { headers: htmlHeaders() })
}
