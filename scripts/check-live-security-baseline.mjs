const HOSTS = ["https://fcuno.com", "https://spc.fcuno.com"]
const SECURITY_TXT_CANONICALS = HOSTS.map(
  (host) => `${host}/.well-known/security.txt`,
)
const REQUEST_TIMEOUT_MS = 15_000
const MINIMUM_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000
const MAXIMUM_EXPIRY_MS = 366 * 24 * 60 * 60 * 1000

const checks = [
  { path: "/", status: 200, label: "public root" },
  {
    path: "/.well-known/security.txt",
    status: 200,
    label: "security.txt",
    securityTxt: true,
  },
  {
    path: "/api/spc/session",
    status: 200,
    label: "anonymous session API",
    privateJsonResponse: true,
  },
  {
    path: "/api/spc/users",
    status: 401,
    label: "protected user API",
    privateJsonResponse: true,
  },
  {
    path: "/api/spc/audit-logs",
    status: 401,
    label: "protected audit-log API",
    privateJsonResponse: true,
  },
  {
    path: "/api/spc/chrome-extension/download",
    status: 401,
    label: "protected extension download",
    privateJsonResponse: true,
  },
  {
    path: "/api/spc/security-maintenance",
    status: 401,
    label: "protected security maintenance",
    privateJsonResponse: true,
  },
  {
    path: "/__spc_security_baseline_missing__",
    status: 404,
    label: "not-found response",
  },
]

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function headerIncludes(response, name, expected) {
  const actual = response.headers.get(name) ?? ""
  assertCondition(
    actual.toLowerCase().includes(expected.toLowerCase()),
    `${name} should include ${expected}; received ${actual || "<missing>"}`,
  )
}

function validateBaselineHeaders(response) {
  const enforcedCsp = response.headers.get("content-security-policy") ?? ""
  const stagedCsp =
    response.headers.get("content-security-policy-report-only") ?? ""

  for (const directive of [
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "https://*.officeapps.live.com",
    "https://*.microsoft365.com",
    "https://*.cloud.microsoft",
    "upgrade-insecure-requests",
  ]) {
    assertCondition(
      enforcedCsp.includes(directive),
      `enforced CSP should include ${directive}`,
    )
  }

  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
  ]) {
    assertCondition(
      stagedCsp.includes(directive),
      `Report-Only CSP should include ${directive}`,
    )
  }

  headerIncludes(response, "strict-transport-security", "max-age=")
  headerIncludes(response, "x-content-type-options", "nosniff")
  headerIncludes(response, "referrer-policy", "no-referrer")
  for (const feature of [
    "camera=()",
    "microphone=()",
    "geolocation=()",
    "payment=()",
    "usb=()",
  ]) {
    headerIncludes(response, "permissions-policy", feature)
  }
  assertCondition(
    !response.headers.has("x-powered-by"),
    "X-Powered-By should not disclose the framework",
  )
}

function validateSecurityTxt(body, response) {
  headerIncludes(response, "content-type", "text/plain")
  assertCondition(
    /^Contact: mailto:info@cosulich\.it$/m.test(body),
    "security.txt should publish the approved contact",
  )

  const canonicals = [...body.matchAll(/^Canonical: (.+)$/gm)].map(
    (match) => match[1],
  )
  assertCondition(
    JSON.stringify(canonicals) === JSON.stringify(SECURITY_TXT_CANONICALS),
    `security.txt canonical URLs should be ${SECURITY_TXT_CANONICALS.join(", ")}`,
  )

  const expires = body.match(/^Expires: (.+)$/m)?.[1]
  assertCondition(Boolean(expires), "security.txt should publish Expires")
  const remainingMs = Date.parse(expires) - Date.now()
  assertCondition(
    Number.isFinite(remainingMs) && remainingMs >= MINIMUM_EXPIRY_MS,
    "security.txt should be renewed before fewer than 90 days remain",
  )
  assertCondition(
    remainingMs <= MAXIMUM_EXPIRY_MS,
    "RFC 9116 expiry should not be more than one year in the future",
  )
}

function validatePrivateJsonResponse(response, host, label) {
  headerIncludes(response, "content-type", "application/json")
  const cacheControl = (response.headers.get("cache-control") ?? "").toLowerCase()
  assertCondition(
    cacheControl.includes("private") && cacheControl.includes("no-store"),
    `${host} ${label} should be private and no-store; received ${cacheControl || "<missing>"}`,
  )
}

async function fetchChecked(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "user-agent": "FCUNO-SPC-security-baseline-check/1.0",
      ...options.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

async function checkHttpsRedirect(host) {
  const httpUrl = host.replace(/^https:/, "http:")
  const response = await fetchChecked(`${httpUrl}/`, { redirect: "manual" })
  assertCondition(
    [301, 302, 307, 308].includes(response.status),
    `${httpUrl} should redirect to HTTPS; received ${response.status}`,
  )
  const location = response.headers.get("location") ?? ""
  assertCondition(
    location.startsWith(host),
    `${httpUrl} should redirect to ${host}; received ${location || "<missing>"}`,
  )
  return { host, check: "HTTP to HTTPS", status: response.status }
}

async function checkHost(host) {
  const results = [await checkHttpsRedirect(host)]

  for (const check of checks) {
    const response = await fetchChecked(`${host}${check.path}`)
    assertCondition(
      response.status === check.status,
      `${host} ${check.label} should return ${check.status}; received ${response.status}`,
    )
    validateBaselineHeaders(response)

    if (check.privateJsonResponse) {
      validatePrivateJsonResponse(response, host, check.label)
    }

    if (check.securityTxt) {
      validateSecurityTxt(await response.text(), response)
    }

    results.push({ host, check: check.label, status: response.status })
  }

  return results
}

const results = (await Promise.all(HOSTS.map(checkHost))).flat()
for (const result of results) {
  console.log(`${result.host} — ${result.check}: ${result.status}`)
}
console.log(`Verified ${results.length} live security-baseline checks.`)
