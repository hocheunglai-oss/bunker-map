import Link from "next/link"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: "32px 20px 56px",
  background: "radial-gradient(circle at top, #0e5aa7 0%, #073666 38%, #031b36 100%)",
  color: "#f5fbff",
  fontFamily: "Arial, Helvetica, sans-serif",
}

const shellStyle: React.CSSProperties = {
  maxWidth: "920px",
  margin: "0 auto",
}

const cardStyle: React.CSSProperties = {
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.1), transparent 30%), linear-gradient(180deg, rgba(4, 24, 49, 0.84) 0%, rgba(5, 22, 40, 0.78) 100%)",
  border: "1px solid rgba(173, 216, 255, 0.18)",
  borderRadius: "24px",
  boxShadow: "0 28px 72px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255,255,255,0.05)",
  backdropFilter: "blur(16px)",
  padding: "24px",
}

const pillButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "10px 18px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.18)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  textDecoration: "none",
  fontWeight: 700,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
}

export default function DisclaimerPage() {
  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <div style={{ ...cardStyle, position: "relative", overflow: "hidden" }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: "3px",
              background: "linear-gradient(90deg, #5aa9ff 0%, #7fd0ff 50%, #5aa9ff 100%)",
            }}
          />

          <div style={{ textAlign: "center", marginBottom: "18px" }}>
            <div
              style={{
                fontSize: "12px",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "#8fd7ff",
                marginBottom: "8px",
                fontWeight: 700,
              }}
            >
              Disclaimer
            </div>

            <h1
              style={{
                margin: 0,
                fontSize: "clamp(1.05rem, 2vw, 1.35rem)",
                lineHeight: 1.2,
                letterSpacing: "0.06em",
                fontWeight: 600,
                color: "#e8f4ff",
                textTransform: "uppercase",
              }}
            >
              For Indication Only
            </h1>
          </div>

          <div style={{ display: "grid", gap: "16px", color: "#e7f3ff", lineHeight: 1.75, fontSize: "15px" }}>
            <p style={{ margin: 0 }}>
              The information and prices provided herein are for general informational purposes only and
              reflect indicative market assessments based on available data sources. They do not
              constitute firm offers, quotations, or recommendations to buy or sell marine fuels or
              related products.
            </p>

            <p style={{ margin: 0 }}>
              While reasonable efforts are made to ensure accuracy and timeliness, no representation or
              warranty, express or implied, is made as to the completeness, accuracy, or reliability of
              the information. Prices may vary significantly depending on supplier, location, quantity,
              timing, credit terms, and market conditions.
            </p>

            <p style={{ margin: 0 }}>
              To the fullest extent permitted by law, no liability is accepted for any loss or damage
              arising directly or indirectly from the use of, or reliance on, this information. Users
              should independently verify all data and obtain firm quotations before making any
              commercial or trading decisions.
            </p>
          </div>
        </div>

        <div style={{ marginTop: "20px", textAlign: "center" }}>
          <Link href="/" style={pillButtonStyle}>
            Back To Bunker Map
          </Link>
        </div>
      </div>
    </div>
  )
}
