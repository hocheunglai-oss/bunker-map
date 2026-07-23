import assert from "node:assert/strict"
import test from "node:test"
import {
  sanitizeEmailTemplate,
  sanitizeTemplateBodyHtml,
} from "../lib/emailTemplateSanitizer"

test("removes active content and event handlers while preserving safe formatting", () => {
  const sanitized = sanitizeTemplateBodyHtml(`
    <div onclick="alert(1)" onmouseover="alert(2)">
      <p>Hello <strong>world</strong></p>
      <script><p>script payload</p></script>
      <style>body { background: url(javascript:alert(3)); }</style>
      <svg onload="alert(4)"><a href="javascript:alert(5)">svg payload</a></svg>
      <math><mi href="javascript:alert(6)">math payload</mi></math>
      <iframe srcdoc="<script>alert(7)</script>">iframe payload</iframe>
      <object data="javascript:alert(8)">object payload</object>
      <embed src="javascript:alert(9)">
      <form action="javascript:alert(10)"><input autofocus onfocus="alert(11)">form payload</form>
    </div>
  `)

  assert.match(sanitized, /<p>Hello <strong>world<\/strong><\/p>/)
  assert.doesNotMatch(
    sanitized,
    /(?:<script|<style|<svg|<math|<iframe|<object|<embed|<form|<input|\son[a-z]+\s*=|payload)/i
  )
})

test("blocks dangerous link, image, and CSS schemes", () => {
  const sanitized = sanitizeTemplateBodyHtml(`
    <p style="
      color:#123;
      width:100%;
      background:url(javascript:alert(1));
      behavior:url(#default#time2);
      -moz-binding:url(https://evil.example/xss.xml#xss);
      position:fixed;
    ">
      <a href="java&#x73;cript:alert(2)" target="_blank">script link</a>
      <a href="data:text/html,&lt;script&gt;alert(3)&lt;/script&gt;">data link</a>
      <a href="//evil.example/path">protocol-relative link</a>
      <a href="https://example.com/path" target="_blank" rel="opener">safe link</a>
      <img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" onerror="alert(4)">
      <img src="cid:company-logo@example" width="32" onload="alert(5)">
    </p>
  `)

  assert.match(sanitized, /style="color:#123;width:100%"/)
  assert.match(
    sanitized,
    /<a href="https:\/\/example\.com\/path" target="_blank" rel="noopener noreferrer">safe link<\/a>/
  )
  assert.match(sanitized, /<img width="32" src="cid:company-logo@example" \/>/)
  assert.doesNotMatch(
    sanitized,
    /javascript|data:text|data:image\/svg|url\s*\(|behavior|-moz-binding|position:|onerror|onload/i
  )
  assert.doesNotMatch(sanitized, /href="\/\/evil\.example/)
  assert.match(sanitized, /script link/)
  assert.match(sanitized, /data link/)
  assert.match(sanitized, /protocol-relative link/)
})

test("allows raster data images but rejects executable image formats", () => {
  const safePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const sanitized = sanitizeTemplateBodyHtml(`
    <img src="${safePng}" alt="pixel">
    <img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+" alt="svg">
  `)

  assert.match(sanitized, new RegExp(safePng.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(sanitized, /alt="pixel"/)
  assert.doesNotMatch(sanitized, /image\/svg|alt="svg"/i)
})

test("normalizes arbitrary Outlook tables into safe presentation tables", () => {
  const sanitized = sanitizeTemplateBodyHtml(`
    <table onclick="alert(1)" style="background:url(javascript:alert(2))">
      <tr><td onmouseover="alert(3)">Vessel</td><td>:</td><td>FC UNO</td></tr>
      <tr><td>Port</td><td>:</td><td>Singapore</td></tr>
    </table>
  `)

  assert.match(sanitized, /<table data-fc-safe-template-table="1" role="presentation"/)
  assert.match(sanitized, /mso-table-lspace:0pt/)
  assert.match(sanitized, /border:1px solid #b8c0c8/)
  assert.match(sanitized, />Vessel<\/td><td[^>]*>:<\/td><td[^>]*>FC UNO<\/td>/)
  assert.doesNotMatch(sanitized, /onclick|onmouseover|javascript|url\s*\(/i)
})

test("sanitizes complete records deterministically before they reach innerHTML consumers", () => {
  const source = {
    subject: "=?UTF-8?Q?Safe_subject?=",
    to: "recipient@example.com",
    bodyHtml: `<div><em>Allowed</em><img src=x onerror=alert(1)><script>alert(2)</script></div>`,
    bodyText: "stale text",
  }

  const once = sanitizeEmailTemplate(source)
  const twice = sanitizeEmailTemplate(once)

  assert.deepEqual(twice, once)
  assert.equal(once.subject, "Safe subject")
  assert.match(once.bodyHtml, /<em>Allowed<\/em>/)
  assert.doesNotMatch(once.bodyHtml, /onerror|script|alert/i)
  assert.equal(once.bodyText, "Allowed")
})
