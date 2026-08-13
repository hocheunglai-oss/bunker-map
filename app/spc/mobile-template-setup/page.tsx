"use client"
import { useState } from "react"
import { SpcShell } from "@/components/SpcShell"
export default function Page() {
  const [status, setStatus] = useState("")
  return <SpcShell title="Mobile Template Setup"><section className="spc-panel" style={{maxWidth:480,margin:"40px auto",padding:20}}>
    <button className="spc-blue-action" onClick={async()=>{const response=await fetch("/api/spc/mobile-mode/template-setup",{method:"POST"});const body=await response.json();setStatus(response.ok?`READY: ${body.status}`:body.message)}}>REGISTER TEMPLATE</button>
    {status?<p role="status">{status}</p>:null}
  </section></SpcShell>
}
