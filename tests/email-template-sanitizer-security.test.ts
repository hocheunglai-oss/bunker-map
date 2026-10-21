import assert from "node:assert/strict"
import test from "node:test"
import {
  sanitizeEmailTemplate,
  sanitizeTemplateBodyHtml,
  sanitizeTemplateText,
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

test("preserves only the trusted FCUNO H-drive file-link namespace", () => {
  const trustedHref =
    "file:///H:/Task%20Administration%20-Accounting/General%20Expense%20Administration/Bank%20Payment%20Expense/Bank%20Payment%20General%20Expense%20Administration.xlsm"
  const sanitized = sanitizeTemplateBodyHtml(`
    <a href="${trustedHref}">trusted H-drive workbook</a>
    <a href="file:///C:/Users/Public/unsafe.xlsx">other local drive</a>
    <a href="file://server/share/unsafe.xlsx">UNC share</a>
    <a href="file:///H:/Approved/../Restricted/unsafe.xlsx">path traversal</a>
    <a href="file:///H:/Approved/%2e%2e/Restricted/encoded-unsafe.xlsx">encoded traversal</a>
  `)

  assert.match(
    sanitized,
    new RegExp(`<a href="${trustedHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">trusted H-drive workbook<\\/a>`)
  )
  assert.doesNotMatch(sanitized, /href="file:\/\/\/C:/i)
  assert.doesNotMatch(sanitized, /href="file:\/\/server/i)
  assert.doesNotMatch(sanitized, /href="[^"]*(?:\.\.|%2e%2e)/i)
  assert.match(sanitized, /other local drive/)
  assert.match(sanitized, /UNC share/)
  assert.match(sanitized, /path traversal/)
  assert.match(sanitized, /encoded traversal/)
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

test("noscript discard survives an implied ancestor close without denying legitimate HTTPS content", () => {
  const discarded = `<img src="https://discard.example.invalid/pixel.png" alt="DISCARD_IMAGE"><a href="https://discard.example.invalid/">DISCARD_LINK</a>DISCARD_TEXT`
  const sanitized = sanitizeTemplateBodyHtml(`<div>BEFORE<noscript></div>${discarded}</noscript><p>AFTER</p>`)
  assert.doesNotMatch(sanitized, /DISCARD_|discard\.example/i)
  assert.match(sanitized, /BEFORE/)
  assert.match(sanitized, /<p>AFTER<\/p>/)

  const allowed = sanitizeTemplateBodyHtml(`<div>BEFORE</div>${discarded}<p>AFTER</p>`)
  assert.match(allowed, /src="https:\/\/discard\.example\.invalid\/pixel\.png"/)
  assert.match(allowed, /href="https:\/\/discard\.example\.invalid\/"/)
  assert.match(allowed, /DISCARD_IMAGE/)
  assert.match(allowed, /DISCARD_LINK/)
  assert.match(allowed, /DISCARD_TEXT/)
})

test("nested and case-varied noscript regions retain their discard boundary and outside formatting", () => {
  for (const [open, close] of [["div", "div"], ["p", "p"], ["div><span", "span"]]) {
    for (const tag of ["noscript", "NOSCRIPT"]) {
      const sanitized = sanitizeTemplateBodyHtml(`<${open}>BEFORE<${tag}></${close}><strong>DISCARD_NESTED</strong><img src="https://discard.example.invalid/nested.png"></${tag}><p><em>AFTER</em></p>`)
      assert.doesNotMatch(sanitized, /DISCARD_NESTED|discard\.example/i)
      assert.match(sanitized, /BEFORE/)
      assert.match(sanitized, /<p><em>AFTER<\/em><\/p>/)
    }
  }
})

test("MIME HTML representations reach the same noscript discard policy", () => {
  const html = '<div>BEFORE<noscript></div><img src="https://discard.example.invalid/mime.png">DISCARD_MIME</noscript><p>AFTER</p>'
  const encoded = html.replace(/=/g, "=3D").replace(/</g, "=3C").replace(/>/g, "=3E")
  const inputs = [
    `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${encoded}`,
    `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString("base64")}`,
  ]
  for (const input of inputs) {
    const sanitized = sanitizeTemplateBodyHtml(input)
    assert.doesNotMatch(sanitized, /DISCARD_MIME|discard\.example/i)
    assert.match(sanitized, /BEFORE/)
    assert.match(sanitized, /<p>AFTER<\/p>/)
  }
})

test("CDATA parser-boundary variant cannot expose content from a noscript discard region", () => {
  const sanitized = sanitizeTemplateBodyHtml('<p>BEFORE</p><![CDATA[ x > <noscript>]]><a href="https://discard.example.invalid/">DISCARD_CDATA</a><img src="https://discard.example.invalid/cdata.png"></noscript><p>AFTER</p>')
  assert.doesNotMatch(sanitized, /DISCARD_CDATA|discard\.example/i)
  assert.match(sanitized, /BEFORE/)
  assert.match(sanitized, /<p>AFTER<\/p>/)
})

test("balanced discard regions and inert tag lookalikes do not remove outside content", () => {
  const sanitized = sanitizeTemplateBodyHtml('<p><strong>BEFORE</strong></p><noscript><p>DISCARD_BALANCED</p></noscript><p><em>AFTER</em> &lt;noscript&gt; literal text</p>')
  assert.doesNotMatch(sanitized, /DISCARD_BALANCED|<noscript/i)
  assert.match(sanitized, /<strong>BEFORE<\/strong>/)
  assert.match(sanitized, /<em>AFTER<\/em>/)
  assert.match(sanitized, /&lt;noscript&gt; literal text/)
  const rawText = sanitizeTemplateBodyHtml('<textarea><noscript>INERT_TEXTAREA</textarea><p>OUTSIDE_TEXTAREA</p>')
  assert.doesNotMatch(rawText, /INERT_TEXTAREA|<textarea|<noscript/i)
  assert.match(rawText, /<p>OUTSIDE_TEXTAREA<\/p>/)
})

test("all namespaced SMIL animation forms stay excluded by the application allowlist", () => {
  for (const prefix of ["svg", "xlink", "xml", "SVG"]) {
    for (const tag of ["animate", "animateColor", "animateMotion", "animateTransform", "set"]) {
      const sanitized = sanitizeTemplateBodyHtml(`<p>BEFORE</p><svg><a href="#safe"><${prefix}:${tag} attributeName="href" values="#safe;javascript:alert(1)" dur=".01s" fill="freeze"/><text>DISCARD_SMIL</text></a></svg><p>AFTER</p>`)
      assert.doesNotMatch(sanitized, /<svg|<(?:svg|xlink|xml):|attributeName|javascript:|DISCARD_SMIL/i)
      assert.match(sanitized, /<p>BEFORE<\/p>/)
      assert.match(sanitized, /<p>AFTER<\/p>/)
    }
  }
})

test("meta refresh stays rejected independently of nested URL schemes", () => {
  for (const destination of ["javascript:alert(1)", "data:text/html,DISCARD_REFRESH", "https://discard.example.invalid/redirect"]) {
    for (const tag of ["meta", "META"]) {
      const sanitized = sanitizeTemplateBodyHtml(`<p>BEFORE</p><${tag} http-equiv="Refresh" content="0;url=${destination}"><p>AFTER</p>`)
      assert.doesNotMatch(sanitized, /<meta|http-equiv|DISCARD_REFRESH|discard\.example|javascript:|data:text/i)
      assert.match(sanitized, /<p>BEFORE<\/p>/)
      assert.match(sanitized, /<p>AFTER<\/p>/)
    }
  }
})

test("dependency update retains legitimate rich email links images tables placeholders and H-drive files", () => {
  const sanitized = sanitizeTemplateBodyHtml(`
    <p style="color:#123;font-weight:bold">Hello <strong>{{VESSEL}}</strong> <em>team</em></p>
    <a href="https://safe.example.invalid/quote" target="_blank">HTTPS</a>
    <a href="mailto:team@example.invalid">MAIL</a><a href="tel:+85212345678">PHONE</a>
    <a href="/relative/path">RELATIVE</a><a href="file:///H:/Approved/Shared%20File.xlsx">H DRIVE</a>
    <img src="https://safe.example.invalid/logo.png" alt="HTTPS IMAGE">
    <img src="cid:company-logo@example.invalid" alt="CID IMAGE">
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" alt="PNG IMAGE">
    <table><tr><td>Vessel</td><td>ALPHA</td></tr></table>
  `)
  for (const value of ["{{VESSEL}}", "<em>team</em>", "mailto:team@example.invalid", "tel:+85212345678", "/relative/path", "file:///H:/Approved/Shared%20File.xlsx", "HTTPS IMAGE", "CID IMAGE", "PNG IMAGE", "data-fc-safe-template-table", "Vessel", "ALPHA"]) assert.ok(sanitized.includes(value), value)
  assert.match(sanitized, /rel="noopener noreferrer"/)
  assert.match(sanitized, /style="color:#123;font-weight:bold"/)
})

test("leading noscript is removed before MIME-noise first-formatting-tag selection", () => {
  for (const input of [
    "<noscript><p>DISCARD_PREFIX</p></noscript><p>AFTER</p>",
    "<NOSCRIPT><div>DISCARD_PREFIX</div></NOSCRIPT><p>AFTER</p>",
    "<noscript>DISCARD_PREFIX</noscript><p>AFTER</p>",
  ]) {
    const sanitized = sanitizeTemplateBodyHtml(input)
    assert.doesNotMatch(sanitized, /DISCARD_PREFIX|<noscript/i)
    assert.equal(sanitized, "<p>AFTER</p>")
  }
})

test("noscript is removed before table cell text conversion without losing outside cells", () => {
  const sanitized = sanitizeTemplateBodyHtml('<p>BEFORE</p><table><tr><td>VISIBLE<noscript>DISCARD_TABLE</noscript></td><td>SECOND</td></tr></table><p>AFTER</p>')
  assert.doesNotMatch(sanitized, /DISCARD_TABLE|<noscript/i)
  for (const kept of ["BEFORE", "VISIBLE", "SECOND", "AFTER", "data-fc-safe-template-table"]) assert.ok(sanitized.includes(kept), kept)
})

test("HTML5 noscript casing delimiters self-closing and nested raw-text boundaries are respected", () => {
  for (const opener of ["<noscript>", "<NoScRiPt >", "<noscript\t>", "<noscript\n>", "<noscript\f>", "<noscript/>", '<noscript title="safe">']) {
    const sanitized = sanitizeTemplateBodyHtml(`${opener}<p>DISCARD_DELIMITER</p></noscript><p>AFTER</p>`)
    assert.doesNotMatch(sanitized, /DISCARD_DELIMITER|<noscript/i)
    assert.equal(sanitized, "<p>AFTER</p>")
  }
  const nested = sanitizeTemplateBodyHtml('<noscript><noscript>DISCARD_FIRST</noscript><p>VISIBLE_AFTER_FIRST_CLOSE</p></noscript>')
  assert.doesNotMatch(nested, /DISCARD_FIRST/)
  assert.equal(nested, "<p>VISIBLE_AFTER_FIRST_CLOSE</p>")
})

test("decoded MIME and quoted-printable prefix table and CDATA forms share the HTML-only guard", () => {
  for (const html of [
    '<noscript><p>DISCARD_ENCODED</p></noscript><p>AFTER</p>',
    '<p>BEFORE</p><table><tr><td>VISIBLE<noscript>DISCARD_ENCODED</noscript></td></tr></table><p>AFTER</p>',
    '<p>BEFORE</p><![CDATA[ x > <noscript>]]><p>DISCARD_ENCODED</p></noscript><p>AFTER</p>',
  ]) {
    const qp = html.replace(/=/g, "=3D").replace(/</g, "=3C").replace(/>/g, "=3E")
    for (const input of [qp, `Content-Type: text/html\nContent-Transfer-Encoding: quoted-printable\n\n${qp}`, `Content-Type: text/html\nContent-Transfer-Encoding: base64\n\n${Buffer.from(html).toString("base64")}`]) {
      const sanitized = sanitizeTemplateBodyHtml(input)
      assert.doesNotMatch(sanitized, /DISCARD_ENCODED/)
      assert.match(sanitized, /<p>AFTER<\/p>/)
      if (html.includes("VISIBLE")) assert.match(sanitized, /VISIBLE/)
    }
  }
})

test("attribute encoded-literal comment and raw-text lookalikes do not remove legitimate content", () => {
  for (const input of [
    '<p title="literal <noscript> value">ATTRIBUTE_KEEP</p>',
    '<p title="<![CDATA[ x > <noscript>]]>">ATTRIBUTE_KEEP</p>',
  ]) {
    const sanitized = sanitizeTemplateBodyHtml(input)
    assert.match(sanitized, /ATTRIBUTE_KEEP/)
    assert.match(sanitized, /title="[^"]*noscript[^"]*"/)
    assert.doesNotMatch(sanitized, /<noscript/i)
  }
  assert.equal(sanitizeTemplateBodyHtml('<p>&lt;noscript&gt;LITERAL_KEEP&lt;/noscript&gt;</p>'), '<p>&lt;noscript&gt;LITERAL_KEEP&lt;/noscript&gt;</p>')
  assert.equal(sanitizeTemplateBodyHtml('<!-- <p>COMMENT_DROP <noscript></p> --><p>COMMENT_AFTER</p>'), '<p>COMMENT_AFTER</p>')
  for (const tag of ["script", "style", "textarea", "title"]) {
    const sanitized = sanitizeTemplateBodyHtml(`<${tag}>literal <noscript> INERT_DROP</${tag}><p>RAW_TEXT_AFTER</p>`)
    assert.equal(sanitized, "<p>RAW_TEXT_AFTER</p>")
  }
})

test("source locations preserve Unicode and adjacent outside content through nested templates and foreign content", () => {
  const sanitized = sanitizeTemplateBodyHtml('<p>🛳️ 船 BEFORE</p><noscript>DISCARD_ONE</noscript><noscript>DISCARD_TWO</noscript><p>AFTER é</p>')
  assert.equal(sanitized, '<p>🛳️ 船 BEFORE</p><p>AFTER é</p>')
  for (const foreign of ["<svg><foreignObject>", "<math><mtext>"]) {
    const close = foreign.startsWith("<svg") ? "</foreignObject></svg>" : "</mtext></math>"
    const output = sanitizeTemplateBodyHtml(`<p>BEFORE</p>${foreign}<noscript>DISCARD_FOREIGN</noscript>${close}<p>AFTER</p>`)
    assert.doesNotMatch(output, /DISCARD_FOREIGN|<noscript/i)
    assert.match(output, /<p>BEFORE<\/p>/)
    assert.match(output, /<p>AFTER<\/p>/)
  }
  const template = sanitizeTemplateBodyHtml('<p>BEFORE</p><template><noscript>DISCARD_TEMPLATE</noscript></template><p>AFTER</p>')
  assert.doesNotMatch(template, /DISCARD_TEMPLATE|<template|<noscript/i)
  assert.match(template, /<p>AFTER<\/p>/)
})

test("an unterminated actual noscript is discarded to EOF without losing its preceding content", () => {
  for (const opening of ["<noscript>", "<NoScRiPt/>", '<noscript title="quoted > delimiter">']) {
    for (const suffix of ["", "DISCARD_EOF", '<img src="https://discard.example.invalid/">DISCARD_EOF', "<!--DISCARD_EOF", "🛳 DISCARD_EOF"]) {
      assert.equal(sanitizeTemplateBodyHtml(`<p>BEFORE</p>${opening}${suffix}`), "<p>BEFORE</p>")
      assert.equal(sanitizeTemplateBodyHtml(`${opening}${suffix}`), "<p></p>")
    }
  }
  for (const closing of ["</noscript>", "</NoScRiPt >", "</noscript/>", "</noscript data-ignored>"]) {
    assert.equal(sanitizeTemplateBodyHtml(`<p>BEFORE</p><noscript>DISCARD</noscriptx><p>ALSO_DISCARD</p>${closing}<p>AFTER</p>`), "<p>BEFORE</p><p>AFTER</p>")
  }
})

test("plain-text normalization keeps its established semantics instead of adopting HTML discard rules", () => {
  const raw = '<p>BEFORE</p><noscript>PLAIN_TEXT_KEEP</noscript><p>AFTER</p>'
  assert.equal(sanitizeTemplateText(raw), 'BEFORE\nPLAIN_TEXT_KEEPAFTER')
  assert.doesNotMatch(sanitizeTemplateBodyHtml(raw), /PLAIN_TEXT_KEEP/)
})
