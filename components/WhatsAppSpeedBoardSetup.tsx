"use client"

import Link from "next/link"

type WhatsAppSpeedBoardSetupProps = {
  backHref: string
  title?: string
}

const extensionPath = "tools/whatsapp-speed-board"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "22px",
}

const shellStyle: React.CSSProperties = {
  width: "min(1180px, 100%)",
  margin: "0 auto",
  display: "grid",
  gap: "16px",
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "14px",
  minHeight: "54px",
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--fc-admin-heading)",
  fontSize: "26px",
  fontWeight: 900,
  letterSpacing: 0,
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "8px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px rgba(29, 29, 31, 0.06)",
  overflow: "hidden",
}

const panelHeaderStyle: React.CSSProperties = {
  minHeight: "52px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
  padding: "12px 16px",
}

const panelTitleStyle: React.CSSProperties = {
  margin: 0,
  color: "var(--fc-admin-heading)",
  fontSize: "14px",
  fontWeight: 900,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
}

const bodyStyle: React.CSSProperties = {
  display: "grid",
  gap: "14px",
  padding: "16px",
}

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "12px",
}

const factStyle: React.CSSProperties = {
  minHeight: "92px",
  display: "grid",
  alignContent: "space-between",
  border: "1px solid var(--fc-admin-border-soft)",
  borderRadius: "8px",
  background: "#ffffff",
  padding: "12px",
}

const factLabelStyle: React.CSSProperties = {
  color: "var(--fc-admin-muted)",
  fontSize: "11px",
  fontWeight: 900,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
}

const factValueStyle: React.CSSProperties = {
  color: "var(--fc-admin-heading)",
  fontSize: "17px",
  fontWeight: 900,
  lineHeight: 1.22,
}

const stepsStyle: React.CSSProperties = {
  margin: 0,
  display: "grid",
  gap: "9px",
  color: "var(--fc-admin-panel-text)",
  fontSize: "14px",
  lineHeight: 1.45,
  paddingLeft: "20px",
}

const codeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "30px",
  border: "1px solid var(--fc-admin-border-soft)",
  borderRadius: "7px",
  background: "#f6f7f8",
  color: "var(--fc-admin-heading)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "12px",
  fontWeight: 800,
  padding: "0 9px",
}

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "10px",
}

const actionStyle: React.CSSProperties = {
  minHeight: "38px",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 900,
  padding: "0 16px",
  textDecoration: "none",
}

export function WhatsAppSpeedBoardSetup({
  backHref,
  title = "WhatsApp Speed Board",
}: WhatsAppSpeedBoardSetupProps) {
  return (
    <div style={pageStyle}>
      <main style={shellStyle}>
        <div style={headerStyle}>
          <div>
            <h1 style={titleStyle}>{title}</h1>
            <p style={{ margin: "5px 0 0", color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 800 }}>
              Trading-hour mode: save and jump between WhatsApp Web chats.
            </p>
          </div>
          <Link href={backHref} className="fc-admin-nav-button" style={actionStyle}>
            Back
          </Link>
        </div>

        <section style={panelStyle}>
          <div style={panelHeaderStyle}>
            <h2 style={panelTitleStyle}>Speed Rules</h2>
          </div>
          <div style={bodyStyle}>
            <div style={gridStyle}>
              <div style={factStyle}>
                <span style={factLabelStyle}>Phonebook</span>
                <strong style={factValueStyle}>Not loaded</strong>
              </div>
              <div style={factStyle}>
                <span style={factLabelStyle}>Meta API</span>
                <strong style={factValueStyle}>Not used</strong>
              </div>
              <div style={factStyle}>
                <span style={factLabelStyle}>Storage</span>
                <strong style={factValueStyle}>Trader browser only</strong>
              </div>
            </div>
            <div style={actionRowStyle}>
              <a href="https://web.whatsapp.com" target="_blank" rel="noreferrer" style={actionStyle}>
                Open WhatsApp Web
              </a>
              <span style={codeStyle}>{extensionPath}</span>
            </div>
          </div>
        </section>

        <section style={panelStyle}>
          <div style={panelHeaderStyle}>
            <h2 style={panelTitleStyle}>Install Extension</h2>
          </div>
          <div style={bodyStyle}>
            <ol style={stepsStyle}>
              <li>Open Chrome and go to <span style={codeStyle}>chrome://extensions</span>.</li>
              <li>Enable Developer mode.</li>
              <li>Click Load unpacked.</li>
              <li>Select <span style={codeStyle}>{extensionPath}</span>.</li>
              <li>Open WhatsApp Web. The FCUNO Supplier and Buyer board appears on the right.</li>
            </ol>
          </div>
        </section>

        <section style={panelStyle}>
          <div style={panelHeaderStyle}>
            <h2 style={panelTitleStyle}>Trading Workflow</h2>
          </div>
          <div style={bodyStyle}>
            <ol style={stepsStyle}>
              <li>Open the WhatsApp chat once.</li>
              <li>Click Add as Supplier or Add as Buyer in the FCUNO side panel.</li>
              <li>Drag contacts into the order you want.</li>
              <li>Click a saved contact to jump back to that chat. Phone-number chats open directly.</li>
            </ol>
          </div>
        </section>
      </main>
    </div>
  )
}
