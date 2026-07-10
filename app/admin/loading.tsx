export default function AdminLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "45vh",
        display: "grid",
        placeItems: "center",
        padding: "32px",
        background: "var(--fc-admin-page-bg)",
        color: "var(--fc-admin-muted)",
        fontFamily: "var(--fc-admin-font)",
        fontSize: "13px",
        fontWeight: 800,
      }}
    >
      Loading admin tool...
    </div>
  )
}
