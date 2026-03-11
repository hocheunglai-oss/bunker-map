"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

export default function AdminPage(){

const [ports,setPorts] = useState<any[]>([])
const [loading,setLoading] = useState(false)

const today = new Date().toDateString()

const th = {
border:"1px solid #cbd5e1",
padding:"8px"
}

const td = {
border:"1px solid #e2e8f0",
padding:"6px"
}

/* LOAD PORTS */

const loadPorts = async()=>{

const {data,error} = await supabase
.from("ports")
.select("*")
.order("display_order",{ascending:true})

if(error){
console.error(error)
return
}

setPorts(data || [])

}

useEffect(()=>{loadPorts()},[])

/* UPDATE LOCAL STATE */

const updateValue=(id:string,field:string,value:any)=>{

setPorts(prev =>
prev.map(p =>
p.id===id ? {...p,[field]:value} : p
)
)

}

/* SAVE PORT */

const savePort = async(port:any)=>{

setLoading(true)

const now = new Date()

await supabase
.from("ports")
.update({
name:port.name,
lat:port.lat ? Number(port.lat) : null,
lng:port.lng ? Number(port.lng) : null,
hsfo:port.hsfo ? Number(port.hsfo) : null,
vlsfo:port.vlsfo ? Number(port.vlsfo) : null,
mgo:port.mgo ? Number(port.mgo) : null,
hsfo_formula:port.hsfo_formula || null,
vlsfo_formula:port.vlsfo_formula || null,
mgo_formula:port.mgo_formula || null,
updated_at:now
})
.eq("id",port.id)

/* PRICE HISTORY */

await supabase
.from("price_history")
.insert({
port_id:port.id,
hsfo:port.hsfo ? Number(port.hsfo) : null,
vlsfo:port.vlsfo ? Number(port.vlsfo) : null,
mgo:port.mgo ? Number(port.mgo) : null
})

/* UPDATE UI */

setPorts(prev =>
prev.map(p =>
p.id===port.id
? {...p,updated_at:now.toISOString()}
: p
)
)

setLoading(false)

}

/* DELETE PORT */

const deletePort = async(id:string,name:string)=>{

if(!confirm("Delete "+name+" ?")) return

await supabase
.from("ports")
.delete()
.eq("id",id)

setPorts(prev => prev.filter(p => p.id !== id))

}

/* ADD PORT */

const addPort = async()=>{

const {data} = await supabase
.from("ports")
.insert({
name:"New Port",
display_order:ports.length+1
})
.select()

if(data){
setPorts([...ports,...data])
}

}

/* ADD DIVIDER */

const addDivider = async()=>{

const {data} = await supabase
.from("ports")
.insert({
name:"Section",
type:"divider",
display_order:ports.length+1
})
.select()

if(data){
setPorts([...ports,...data])
}

}

/* DRAG START */

const dragStart=(e:any,index:number)=>{
e.dataTransfer.setData("index",index)
}

/* DROP */

const dragDrop=async(e:any,index:number)=>{

const from = Number(e.dataTransfer.getData("index"))

const newPorts=[...ports]

const item=newPorts.splice(from,1)[0]

newPorts.splice(index,0,item)

setPorts(newPorts)

/* SAVE ORDER */

for(let i=0;i<newPorts.length;i++){

await supabase
.from("ports")
.update({display_order:i+1})
.eq("id",newPorts[i].id)

}

}

/* STATUS */

const isUpdatedToday=(date:any)=>{

if(!date) return false

return new Date(date).toDateString()===today

}

/* UI */

return(

<div style={{
padding:"40px",
fontFamily:"Arial"
}}>

<h1 style={{
fontSize:"28px",
color:"#0b3d6d",
marginBottom:"20px"
}}>
Port Price Admin
</h1>

<div style={{marginBottom:"20px"}}>

<button
onClick={addPort}
style={{
background:"#0b5ed7",
color:"white",
padding:"8px 16px",
border:"none",
borderRadius:"4px",
marginRight:"10px",
cursor:"pointer"
}}

>

* Add Port

  </button>

<button
onClick={addDivider}
style={{
background:"#0b5ed7",
color:"white",
padding:"8px 16px",
border:"none",
borderRadius:"4px",
cursor:"pointer"
}}

>

* Add Section Divider

  </button>

</div>

<table style={{
width:"100%",
borderCollapse:"collapse"
}}>

<thead>

<tr style={{
background:"#0b3d6d",
color:"white"
}}>

<th style={th}>↕</th>
<th style={th}>Status</th>
<th style={th}>Port</th>
<th style={th}>Lat</th>
<th style={th}>Lng</th>
<th style={th}>HSFO</th>
<th style={th}>VLSFO</th>
<th style={th}>MGO</th>
<th style={th}>Updated</th>
<th style={th}>Save</th>
<th style={th}>Delete</th>

</tr>

</thead>

<tbody>

{ports.map((port,i)=>{

/* DIVIDER */

if(port.type==="divider"){

return(

<tr key={port.id}
draggable
onDragStart={e=>dragStart(e,i)}
onDrop={e=>dragDrop(e,i)}
onDragOver={e=>e.preventDefault()}
>

<td style={td}>↕</td>

<td style={td} colSpan={7}>

<input
value={port.name}
onChange={e=>updateValue(port.id,"name",e.target.value)}
style={{
width:"100%",
fontWeight:"bold",
fontSize:"16px"
}}
/>

</td>

<td style={td}></td>

<td style={td}>

<button
onClick={()=>deletePort(port.id,port.name)}
style={{
background:"#e63946",
color:"white",
padding:"6px 12px",
border:"none"
}}

>

Delete </button>

</td>

</tr>

)

}

const updated = isUpdatedToday(port.updated_at)

return(

<tr key={port.id}
draggable
onDragStart={e=>dragStart(e,i)}
onDrop={e=>dragDrop(e,i)}
onDragOver={e=>e.preventDefault()}
>

<td style={td}>↕</td>

<td style={td}>
{updated ? "🟢":"🔴"}
</td>

<td style={td}>

<input
value={port.name ?? ""}
onChange={e=>updateValue(port.id,"name",e.target.value)}
/>

</td>

<td style={td}>

<input
value={port.lat ?? ""}
onChange={e=>updateValue(port.id,"lat",e.target.value)}
style={{width:"90px"}}
/>

</td>

<td style={td}>

<input
value={port.lng ?? ""}
onChange={e=>updateValue(port.id,"lng",e.target.value)}
style={{width:"90px"}}
/>

</td>

<td style={td}>

<input
placeholder="price"
value={port.hsfo ?? ""}
onChange={e=>updateValue(port.id,"hsfo",e.target.value)}
style={{width:"60px"}}
/>

<input
placeholder="formula"
value={port.hsfo_formula ?? ""}
onChange={e=>updateValue(port.id,"hsfo_formula",e.target.value)}
style={{width:"100px",marginLeft:"6px"}}
/>

</td>

<td style={td}>

<input
placeholder="price"
value={port.vlsfo ?? ""}
onChange={e=>updateValue(port.id,"vlsfo",e.target.value)}
style={{width:"60px"}}
/>

<input
placeholder="formula"
value={port.vlsfo_formula ?? ""}
onChange={e=>updateValue(port.id,"vlsfo_formula",e.target.value)}
style={{width:"100px",marginLeft:"6px"}}
/>

</td>

<td style={td}>

<input
placeholder="price"
value={port.mgo ?? ""}
onChange={e=>updateValue(port.id,"mgo",e.target.value)}
style={{width:"60px"}}
/>

<input
placeholder="formula"
value={port.mgo_formula ?? ""}
onChange={e=>updateValue(port.id,"mgo_formula",e.target.value)}
style={{width:"100px",marginLeft:"6px"}}
/>

</td>

<td style={td}>

{port.updated_at
? new Date(port.updated_at).toLocaleDateString("en-GB")
: "-"}

</td>

<td style={td}>

<button
onClick={()=>savePort(port)}
disabled={loading}
style={{
background:"#1fa97a",
color:"white",
padding:"6px 12px",
border:"none"
}}

>

Save </button>

</td>

<td style={td}>

<button
onClick={()=>deletePort(port.id,port.name)}
style={{
background:"#e63946",
color:"white",
padding:"6px 12px",
border:"none"
}}

>

Delete </button>

</td>

</tr>

)

})}

</tbody>

</table>

</div>

)

}
