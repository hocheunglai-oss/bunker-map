"use client"

import { useRouter } from "next/navigation"

export default function AdminPage() {

  const router = useRouter()

  return (

    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "#f4f6f8"
      }}
    >

      <div
        style={{
          background: "white",
          padding: 40,
          borderRadius: 10,
          boxShadow: "0 6px 20px rgba(0,0,0,0.1)",
          width: 360
        }}
      >

        <h2 style={{ marginBottom: 30 }}>Admin Panel</h2>

        <button
          onClick={() => router.push("/admin-9f3kL2bunker/taiwan-remarks")}
          style={buttonStyle}
        >
          Taiwan Posted Price Remarks
        </button>

        <button
          onClick={() => router.push("/admin-9f3kL2bunker/pricesetter")}
          style={buttonStyle}
        >
          Price Setter
        </button>

      </div>

    </div>

  )

}

const buttonStyle = {
  width: "100%",
  padding: "12px",
  marginBottom: "15px",
  border: "none",
  borderRadius: "6px",
  background: "#0a3d62",
  color: "white",
  cursor: "pointer",
  fontSize: "15px"
}