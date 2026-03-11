"use client"

import { useEffect, useState } from "react"
import { supabase } from "../../../lib/supabase"

const portsWanted = ["Kaohsiung","Keelung","Taichung","Suao","Hualien"]

export default function TaiwanReport(){

const [rows,setRows] = useState<any[]>([])
const [remark,setRemark] = useState("")

const todayDate = new Date().toLocaleDateString("en-GB")


useEffect(()=>{

async function load(){

const {data:ports} = await supabase
.from("ports")
.select("*")
.in("name",portsWanted)

if(!ports) return

const todayStart = new Date()
todayStart.setHours(0,0,0,0)

const {data:history} = await supabase
.from("price_history")
.select("*")
.order("recorded_at",{ascending:false})

function getLast(portId:number){
return history?.find(
(h:any)=>h.port_id===portId &&
new Date(h.recorded_at)<todayStart
) || null
}

function calc(formula:string,fuel:string){

const parts = formula.split(" ")

const refName = parts[0].toLowerCase()
const operator = parts[1]
const value = Number(parts[2])

const ref = ports.find(
(p:any)=>p.name.toLowerCase()===refName
)

if(!ref) return null

const base = Number(ref[fuel])

if(operator==="+") return base+value
if(operator==="-" ) return base-value

return null
}

const result = ports.map((p:any)=>{

let hsfo = p.hsfo
let vlsfo = p.vlsfo
let mgo = p.mgo

if(!vlsfo && p.vlsfo_formula)
vlsfo = calc(p.vlsfo_formula,"vlsfo")

if(!mgo && p.mgo_formula)
mgo = calc(p.mgo_formula,"mgo")

if(!hsfo && p.hsfo_formula)
hsfo = calc(p.hsfo_formula,"hsfo")

let historyPort = p

if(p.vlsfo_formula){

const ref = p.vlsfo_formula.split(" ")[0]

const refPort = ports.find(
(x:any)=>x.name.toLowerCase()===ref.toLowerCase()
)

if(refPort) historyPort = refPort
}

const last = getLast(historyPort.id)

const hsfoToday = p.name==="Kaohsiung" ? hsfo : null
const hsfoLast = p.name==="Kaohsiung" ? last?.hsfo ?? null : null

const vlsfoLast = last?.vlsfo ?? null
const mgoLast = last?.mgo ?? null

return{

port:p.name,

hsfo:{
today:hsfoToday,
last:hsfoLast,
change:hsfoToday!=null && hsfoLast!=null
?hsfoToday-hsfoLast:null
},

vlsfo:{
today:vlsfo,
last:vlsfoLast,
change:vlsfo!=null && vlsfoLast!=null
?vlsfo-vlsfoLast:null
},

mgo:{
today:mgo,
last:mgoLast,
change:mgo!=null && mgoLast!=null
?mgo-mgoLast:null
}

}

})

const portOrder = [
"Kaohsiung",
"Keelung",
"Taichung",
"Suao",
"Hualien"
]

setRows(
result.sort(
(a,b)=>portOrder.indexOf(a.port)-portOrder.indexOf(b.port)
)
)

const {data:remarkData} = await supabase
.from("remarks")
.select("*")
.limit(1)
.single()

if(remarkData) setRemark(remarkData.content)

}

load()

},[])


function color(c:any){

if(c==null) return "white"
if(c>0) return "#27ae60"
if(c<0) return "#e63946"

return "white"
}

function fmt(c:any){

if(c==null) return "-"
if(c>0) return "+"+c
return c
}

function arrow(c:any){

if(c==null || c===0) return ""
return c>0 ? " ▲" : " ▼"
}



return(

<div style={{
background:"#032855",
color:"white",
minHeight:"100vh",
padding:"40px",
fontFamily:"Arial"
}}>


{/* LOGO */}

<div style={{display:"flex",justifyContent:"center",marginBottom:"20px"}}>
<img src="/logo.png" style={{height:"140px"}}/>
</div>


{/* TITLE */}

<h1 style={{
textAlign:"center",
textTransform:"uppercase",
fontSize:"36px",
fontWeight:"700",
marginBottom:"10px"
}}>
Taiwan Posted Price Change
</h1>


{/* DATE */}

<p style={{
textAlign:"center",
textTransform:"uppercase",
fontSize:"16px",
marginBottom:"30px"
}}>
Date: {todayDate}
</p>


{/* BACK BUTTON */}

<div style={{textAlign:"center",marginBottom:"25px"}}>

<a
href="/"
style={{
background:"#e63946",
color:"white",
padding:"12px 26px",
borderRadius:"6px",
textDecoration:"none",
fontWeight:"700",
textTransform:"uppercase",
letterSpacing:"1px"
}}
>
Back To Bunker Map
</a>

</div>



{/* TABLE */}

<div style={{overflowX:"auto"}}>

<table style={{
width:"100%",
borderCollapse:"collapse",
fontSize:"15px",
boxShadow:"0 4px 14px rgba(0,0,0,0.35)"
}}>


<thead>

<tr style={{background:"#0a355b"}}>

<th rowSpan={2}
style={{
padding:"12px",
fontSize:"18px",
borderRight:"2px solid #ffffff44"
}}>
Port
</th>

<th colSpan={3} style={{borderRight:"2px solid #ffffff44"}}>
HSFO
</th>

<th colSpan={3} style={{borderRight:"2px solid #ffffff44"}}>
VLSFO
</th>

<th colSpan={3}>
LSMGO
</th>

</tr>


<tr style={{background:"#0a355b"}}>

<th>Today</th>
<th>Last</th>
<th style={{borderRight:"2px solid #ffffff44"}}>Change</th>

<th>Today</th>
<th>Last</th>
<th style={{borderRight:"2px solid #ffffff44"}}>Change</th>

<th>Today</th>
<th>Last</th>
<th>Change</th>

</tr>

</thead>



<tbody>

{rows.map((r,i)=>(

<tr
key={i}
style={{
textAlign:"center",
background:i%2===0?"#032e6f":"#043b8b",
transition:"background 0.2s"
}}
onMouseEnter={(e:any)=>{
e.currentTarget.style.background="#0451a0"
}}
onMouseLeave={(e:any)=>{
e.currentTarget.style.background=i%2===0?"#032e6f":"#043b8b"
}}
>


<td style={{
fontWeight:"700",
fontSize:"16px",
borderRight:"2px solid #ffffff44"
}}>
{r.port}
</td>


<td>{r.hsfo.today ?? "-"}</td>
<td>{r.hsfo.last ?? "-"}</td>
<td style={{
fontWeight:"700",
color:color(r.hsfo.change),
borderRight:"2px solid #ffffff44"
}}>
{fmt(r.hsfo.change)}{arrow(r.hsfo.change)}
</td>


<td>{r.vlsfo.today ?? "-"}</td>
<td>{r.vlsfo.last ?? "-"}</td>
<td style={{
fontWeight:"700",
color:color(r.vlsfo.change),
borderRight:"2px solid #ffffff44"
}}>
{fmt(r.vlsfo.change)}{arrow(r.vlsfo.change)}
</td>


<td>{r.mgo.today ?? "-"}</td>
<td>{r.mgo.last ?? "-"}</td>
<td style={{
fontWeight:"700",
color:color(r.mgo.change)
}}>
{fmt(r.mgo.change)}{arrow(r.mgo.change)}
</td>


</tr>

))}

</tbody>

</table>

</div>



{/* REMARKS */}

{remark && (

<div style={{
marginTop:"40px",
padding:"20px",
background:"#043b8b",
borderRadius:"8px",
fontSize:"14px"
}}>

<strong>Remarks:</strong>

<div style={{
marginTop:"8px",
whiteSpace:"pre-line"
}}>
{remark}
</div>

</div>

)}



{/* WHATSAPP */}

<div style={{
marginTop:"40px",
padding:"20px",
background:"#043b8b",
borderRadius:"8px",
textAlign:"center"
}}>

<p style={{marginBottom:"12px"}}>
If you need further information please contact us on WhatsApp
</p>

<a
href="https://wa.me/85266885575"
target="_blank"
style={{
background:"#25D366",
color:"white",
padding:"12px 24px",
borderRadius:"6px",
textDecoration:"none",
fontWeight:"600",
textTransform:"uppercase"
}}
>
Contact Us On WhatsApp
</a>

</div>


</div>

)

}