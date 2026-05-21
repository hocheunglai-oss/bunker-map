export default function OutlookAddinLandingPage() {
  return (
    <main style={{ minHeight: "100vh", fontFamily: "Arial, Helvetica, sans-serif", background: "#f5f9fc", color: "#10243a", padding: "32px" }}>
      <div style={{ maxWidth: "760px", margin: "0 auto", background: "#fff", border: "1px solid #d7e6f2", borderRadius: "16px", padding: "24px" }}>
        <h1 style={{ marginTop: 0 }}>Outlook Add-in</h1>
        <p style={{ lineHeight: 1.6 }}>
          This site now exposes a shared Outlook add-in task pane backed by Supabase. In Outlook, sideload the manifest from
          {" "}
          <a href="/api/outlook-addin/manifest">/api/outlook-addin/manifest</a>
          {" "}
          and the add-in will read the shared template library from this site.
        </p>
        <p style={{ lineHeight: 1.6 }}>
          The task pane URL is <a href="/outlook-addin/taskpane">/outlook-addin/taskpane</a>.
        </p>
      </div>
    </main>
  )
}
