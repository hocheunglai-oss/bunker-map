import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { graphCallbackHtmlResponse } from "../app/api/outlook-addressbook/graph/callback/response"

const routeFile = new URL(
  "../app/api/outlook-addressbook/graph/callback/route.ts",
  import.meta.url,
)

function expectedHtml(title: string, body: string) {
  return `<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:Arial,sans-serif;background:#071a2c;color:#edf7ff;padding:32px"><h1>${title}</h1><p>${body}</p><p>You may close this tab and return to FC Uno.</p></body></html>`
}

test("Graph callback escapes decoded error_description payload variants as text", async () => {
  const payloads = [
    {
      raw: `</p><script>alert("xss")</script><p>`,
      escaped:
        "&lt;/p&gt;&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;&lt;p&gt;",
    },
    {
      raw: `<img src=x onerror='alert(1)'>`,
      escaped: "&lt;img src=x onerror=&#39;alert(1)&#39;&gt;",
    },
    {
      raw: "&lt;svg/onload=alert(1)&gt;",
      escaped: "&amp;lt;svg/onload=alert(1)&amp;gt;",
    },
  ]

  for (const payload of payloads) {
    const callbackUrl = new URL("https://fcuno.test/api/outlook-addressbook/graph/callback")
    callbackUrl.searchParams.set("error_description", payload.raw)
    const decodedError = callbackUrl.searchParams.get("error_description")
    assert.equal(decodedError, payload.raw)

    const response = graphCallbackHtmlResponse(
      "Microsoft Graph Consent Failed",
      decodedError || "",
    )
    const responseBody = await response.text()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8")
    assert.ok(responseBody.includes(payload.escaped))
    assert.doesNotMatch(responseBody, /<(?:script|img|svg)\b/i)
  }
})

test("Graph callback escapes title text at both HTML insertion points", async () => {
  const title = `Consent </title><script>alert("title")</script>`
  const escapedTitle =
    "Consent &lt;/title&gt;&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;"
  const responseBody = await graphCallbackHtmlResponse(title, "Denied").text()

  assert.equal(responseBody.split(escapedTitle).length - 1, 2)
  assert.doesNotMatch(responseBody, /<script\b/i)
})

test("Graph callback preserves normal success and failure response HTML", async () => {
  const cases = [
    {
      title: "Microsoft Graph Consent Saved",
      body: "Admin consent has been recorded for this tenant.",
    },
    {
      title: "Microsoft Graph Consent Failed",
      body: "Admin consent was not completed.",
    },
  ]

  for (const value of cases) {
    const response = graphCallbackHtmlResponse(value.title, value.body)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(await response.text(), expectedHtml(value.title, value.body))
  }
})

test("Graph callback keeps authorization and consent controls around the escaped response", async () => {
  const route = await readFile(routeFile, "utf8")
  const authorizationIndex = route.indexOf('await requireAdminAccess("edit")')
  const errorIndex = route.indexOf('url.searchParams.get("error_description")')

  assert.ok(authorizationIndex >= 0)
  assert.ok(errorIndex > authorizationIndex)
  assert.match(
    route,
    /if \(error\) return graphCallbackHtmlResponse\("Microsoft Graph Consent Failed", error\)/,
  )
  assert.match(route, /if \(state !== config\.state\)/)
  assert.match(route, /if \(!adminConsent \|\| !tenantId\)/)
  assert.match(route, /await saveGraphStore\(\{[\s\S]*?adminConsent: true/)
  assert.match(
    route,
    /return graphCallbackHtmlResponse\("Microsoft Graph Consent Saved", "Admin consent has been recorded for this tenant\."\)/,
  )
})
