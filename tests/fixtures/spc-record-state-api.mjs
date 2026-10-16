import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { transformSync } from "esbuild"
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../.."),require=createRequire(import.meta.url)
export const stateActor={authenticated:true,username:"synthetic@example.test",displayName:"Synthetic Editor",role:"ADMIN",userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
export const recordVersion="2026-10-14T01:02:03.123456Z"
export const lostRow={id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",enquiry_number:"SPC-SYNTHETIC",title:"SYNTHETIC VESSEL",vessel_name:"SYNTHETIC VESSEL",port:"Singapore",product:"VLSFO",quantity:"500",delivery_date:"2026-10-20",supplier_name:null,status:"cancelled",notes:"SYNTHETIC VESSEL / Singapore / VLSFO 500mts",revision_number:1,created_by_username:stateActor.username,created_by_display_name:stateActor.displayName,created_at:recordVersion,updated_at:recordVersion}
export const presentationRow={id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",slug:"synthetic",sort_order:10,chapter_label:"CHAPTER 1",section_label:"SECTION",title:"Original",summary:"",narration:"",key_points:[],q_and_a_prompt:"",visual_kind:"video",visual_copy:[],video_path:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/video-original.mp4",video_mime_type:"video/mp4",video_bytes:100,narration_path:null,narration_mime_type:null,narration_bytes:0,duration_seconds:null,media_version:1,revision:1,status:"published",created_at:recordVersion,updated_at:recordVersion}
export const reviewPayload=(overrides={})=>({id:lostRow.id,expectedUpdatedAt:recordVersion,supplierLostReason:"OTHER",supplierLostReasonDetails:"Verified reason",spcComments:"Verified comment",...overrides})
// Real routes, parsers, version checks and audit headers; only auth/transport are synthetic.
/** @param {{createClient:(headers:Record<string,string>)=>unknown,kind?:string,permission?:string,actor?:typeof stateActor|null}} options */
export function createRecordStateRoute({createClient,kind="lost",permission="edit",actor=stateActor}) {
  const mocks={
    "next/server":{NextResponse:{json:Response.json.bind(Response)}},
    "@supabase/supabase-js":{createClient:(_url,_key,options)=>createClient(options?.global?.headers||{})},
    "@/lib/spcAuth":{async requireSpcPagePermission(page,access){assert.equal(page,kind==="lost"?"spc-lost-record":"spc-readme");if(!actor)throw new Error("Unauthorized");if(permission==="none"||(access==="edit"&&permission!=="edit"))throw new Error("Forbidden");return actor},hasSpcPagePermission:()=>permission==="edit"},
  },cache=new Map()
  function load(name,parent=root){
    if(Object.hasOwn(mocks,name))return mocks[name]
    if(!name.startsWith("@/")&&!name.startsWith("."))return require(name)
    const unresolved=name.startsWith("@/")?join(root,name.slice(2)):resolve(parent,name)
    const file=["",".ts",".json",".js"].map(ext=>unresolved+ext).find(existsSync);assert.ok(file,"Unresolved "+name)
    if(file.endsWith(".json"))return JSON.parse(readFileSync(file,"utf8"))
    if(cache.has(file))return cache.get(file).exports
    const mod={exports:{}};cache.set(file,mod)
    const code=transformSync(readFileSync(file,"utf8"),{loader:"ts",format:"cjs",target:"node24"}).code
    new Function("require","module","exports","process",code)(request=>load(request,dirname(file)),mod,mod.exports,{env:{NEXT_PUBLIC_SUPABASE_URL:"https://synthetic.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only-never-remote"}})
    return mod.exports
  }
  const route=load(kind==="lost"?"@/app/api/spc/lost-record/route":"@/app/api/spc/readme/route")
  return {async mutate(payload){const method=kind==="lost"?"PATCH":"POST",response=await route[method](new Request("https://synthetic.invalid/api/spc/"+(kind==="lost"?"lost-record":"readme"),{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}));return{status:response.status,body:await response.json()}}}
}
export function recordStateMemory({beforeWrite=async()=>{},readError=null,writeError=null,loseMediaAck=false}={}) {
  const rows={spc_enquiries:[structuredClone(lostRow)],spc_presentation_chunks:[structuredClone(presentationRow)]},writes=[],removes=[],headers=[]
  let clock=0
  return {rows,writes,removes,headers,client(context){
    headers.push(context)
    return {storage:{from(){return {remove:async paths=>{removes.push(paths);return{data:paths,error:null}},list:async(_id,options)=>({data:[{name:options.search,metadata:{size:123}}],error:null}),createSignedUrls:async paths=>{
      if(loseMediaAck&&writes.length){loseMediaAck=false;return{data:null,error:{message:"Synthetic response loss after commit"}}}
      return{data:paths.map(path=>({path,signedUrl:"https://synthetic.invalid/"+path})),error:null}
    }}}},
      from(table){
        const filters=[];let action="read",payload
        const query={select(){return query},eq(key,value){filters.push([key,value]);return query},order(){return query},limit(){return query},
          update(value){action="update";payload=value;return query},delete(){action="delete";return query},
          single(){return run(true)},maybeSingle(){return run(false)},then(resolve,reject){return run(false,true).then(resolve,reject)}}
        async function run(single,many=false){
          if(table==="spc_lost_reason_options")return{data:[{reason:"OTHER"},{reason:"SUPPLIER NO AVAILS"}],error:null}
          if(action==="read"&&readError)return{data:null,error:readError}
          if(action!=="read"){await beforeWrite();if(writeError)return{data:null,error:writeError}}
          const matches=rows[table].filter(row=>filters.every(([key,value])=>row[key]===value))
          if(action==="update")for(const row of matches)Object.assign(row,structuredClone(payload),{updated_at:"2026-10-16T01:00:00."+String(++clock).padStart(6,"0")+"Z"})
          if(action==="delete")rows[table]=rows[table].filter(row=>!matches.includes(row))
          if(action!=="read"&&matches.length)writes.push({table,action,filters,payload})
          return{data:structuredClone(many?matches:matches[0]||null),error:single&&matches.length!==1?{code:"PGRST116",message:"Singular response required"}:null}
        }
        return query
      }}
    }}
}
