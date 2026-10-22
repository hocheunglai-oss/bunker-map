import assert from "node:assert/strict"
import path from "node:path"
import {transformSync}from"esbuild"
import {createClient}from"@supabase/supabase-js"
import {NextResponse}from"next/server.js"
import * as operationErrors from"../../lib/ccinfoOperationErrors.ts"
import * as saveValidation from"../../lib/ccinfoSave.ts"
import * as deleteValidation from"../../lib/ccinfoDelete.ts"
import * as drivePaths from"../../lib/ccinfoDrivePaths.ts"
import * as escaping from"../../lib/queryEscaping.ts"
import {source,literal,countryId,rootId,targetId,fileId,initialVersion}from"./ccinfo-operation-conflicts.mjs"
export function operationApi(domain,db){
 assert.ok(["rename","delete","files","upload"].includes(domain))
 const controls={error:null,auth:"",beforeRpc:null},calls=[],permissions=[],driveCalls=[],temp=[]
 const syntheticFetch=async(input,init={})=>{
  const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url);assert.equal(url.origin,"https://synthetic-ccinfo-db.invalid")
  if(request.method==="GET"){
   const table=url.pathname.split("/").at(-1);assert.ok(["cc_countries","cc_ports","cc_companies","cc_entry_files","cc_company_files"].includes(table));assert.ok(db)
   let rows=(await db.snapshot())[table];for(const[key,value]of url.searchParams){if(key==="select")continue;assert.ok(["id","entry_id","entry_kind","company_id","deleted_at"].includes(key));const[op,...rest]=value.split(".");assert.ok(["eq","is"].includes(op));rows=rows.filter(row=>op==="is"?row[key]===null:String(row[key])===rest.join("."))}
   return Response.json(request.headers.get("accept")?.includes("vnd.pgrst.object")?(rows[0]??null):rows)
  }
  assert.equal(request.method,"POST");const name=url.pathname.split("/").at(-1),a=await request.json();calls.push({name,args:a})
  if(controls.beforeRpc)await controls.beforeRpc(name,a)
  try{
   if(controls.error)throw controls.error
   const q=literal,n=v=>v===null?"null":q(v)
   const sql={
    rename_ccinfo_country:()=>`select public.rename_ccinfo_country(${q(a.p_id)},${q(a.p_expected_updated_at)},${q(a.p_name)});`,
    delete_ccinfo_record:()=>`select public.delete_ccinfo_record(${q(a.p_kind)},${q(a.p_id)},${q(a.p_expected_updated_at)},${a.p_delete_ports});`,
    rename_ccinfo_folder:()=>`select public.rename_ccinfo_folder(${q(a.p_entry_kind)},${q(a.p_entry_id)},${n(a.p_folder_id)},${q(a.p_folder_path)},${n(a.p_expected_updated_at)},${q(a.p_name)});`,
    move_ccinfo_folder:()=>`select public.move_ccinfo_folder(${q(a.p_entry_kind)},${q(a.p_entry_id)},${n(a.p_folder_id)},${q(a.p_folder_path)},${n(a.p_expected_updated_at)},${q(a.p_target_parent_path)});`,
    delete_ccinfo_folder:()=>`select public.delete_ccinfo_folder(${q(a.p_entry_kind)},${q(a.p_entry_id)},${n(a.p_folder_id)},${q(a.p_folder_path)},${n(a.p_expected_updated_at)});`,
    move_ccinfo_file:()=>`select public.move_ccinfo_file(${q(a.p_entry_kind)},${q(a.p_entry_id)},${q(a.p_source)},${q(a.p_file_id)},${q(a.p_expected_updated_at)},${n(a.p_folder_id)});`,
    prepare_ccinfo_file_target:()=>`select public.prepare_ccinfo_file_target(${q(a.p_entry_kind)},${q(a.p_entry_id)},${n(a.p_folder_id)},${q(a.p_folder_path)});`,
    register_ccinfo_file:()=>`select public.register_ccinfo_file(${q(a.p_entry_kind)},${q(a.p_entry_id)},${n(a.p_folder_id)},${q(a.p_file_name)},${q(a.p_file_type)},${q(a.p_drive_file_id)},${q(a.p_drive_url)});`,
   };assert.ok(Object.hasOwn(sql,name),name)
   return Response.json(db?await db.execute(sql[name]()):{})
  }catch(error){const message=error.message.match?.(/ERROR:\s+[A-Z0-9]{5}: ([^\n]*)/)?.[1]??error.message,details=error.message.match?.(/DETAIL:  ([^\n]*)/)?.[1]??error.details??"SYNTHETIC PRIVATE DETAIL";return Response.json({code:error.code,message,details,hint:null},{status:400})}
 }
 const client=()=>createClient("https://synthetic-ccinfo-db.invalid","synthetic-only-key",{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:syntheticFetch}})
 const drive={files:{list:async()=>{driveCalls.push("list");return{data:{files:[{id:"SYNTHETIC-FOLDER"}]}}},create:async()=>{driveCalls.push("create");return{data:{id:"PRESERVED-UPLOAD",webViewLink:"https://synthetic.invalid/upload"}}},get:async()=>{driveCalls.push("get");return{data:{parents:["SYNTHETIC-OLD-PARENT"]}}},update:async()=>{driveCalls.push("update");return{data:{id:"PRESERVED-ENTRY-DRIVE"}}},delete:async()=>{driveCalls.push("delete");assert.fail("No rejected registration may delete its Drive file")}},permissions:{create:async()=>{driveCalls.push("share");return{data:{}}}}}
 class OAuth2{setCredentials(){}}
 const modules={"node:fs":{existsSync:()=>false,createReadStream:()=>"SYNTHETIC STREAM"},"node:fs/promises":{writeFile:async p=>temp.push(["write",p]),rm:async p=>temp.push(["rm",p])},"node:os":{tmpdir:()=>"/synthetic/temporary"},"node:path":path,"next/server":{NextResponse},"@/lib/ccinfoOperationErrors":operationErrors,"@/lib/ccinfoSave":saveValidation,"@/lib/ccinfoDelete":deleteValidation,"@/lib/ccinfoDrivePaths":drivePaths,"@/lib/queryEscaping":escaping,"@/lib/googleApis":{loadGoogleApis:async()=>({google:{auth:{OAuth2},drive:()=>drive}})},"@/lib/adminAuth":{requireAdminPagePermission:async(page,access)=>{permissions.push({page,access});if(controls.auth)throw Error(controls.auth);return{username:"SYNTHETIC EDITOR"}}},"@/lib/adminAudit":{createAdminAuditContext:s=>s,createAdminAuditedSupabaseClient:(_context,options)=>{assert.deepEqual(options,{useServiceRole:true});return client()}}}
 const loaded={exports:{}},file=domain==="rename"?"rename-country":domain==="delete"?"delete-record":domain
 const code=transformSync(source(`app/api/ccinfo/${file}/route.ts`),{loader:"ts",format:"cjs",target:"node24"}).code
 Function("require","module","exports","process","console",code)(name=>{assert.ok(Object.hasOwn(modules,name),name);return modules[name]},loaded,loaded.exports,{cwd:()=>"/synthetic/app",env:{SUPABASE_SERVICE_ROLE_KEY:"synthetic-only",VERCEL:"1",GOOGLE_OAUTH_CLIENT_ID:"synthetic",GOOGLE_OAUTH_CLIENT_SECRET:"synthetic",GOOGLE_DRIVE_REFRESH_TOKEN:"synthetic",GOOGLE_DRIVE_COMPANY_FOLDER_ID:"synthetic-root"}},{error(){},warn(){}})
 const payload=domain==="rename"?{id:countryId,name:"RENAMED COUNTRY",expectedUpdatedAt:initialVersion}:domain==="delete"?{kind:"country",id:countryId,expectedUpdatedAt:initialVersion,deletePorts:true}:{action:"renameFolder",entryKind:"country",entryId:countryId,entryName:"SYNTHETIC OLD",folderId:rootId,folderPath:"A",name:"RENAMED",expectedUpdatedAt:initialVersion}
 async function request(body=payload,method=domain==="files"?"PATCH":"POST"){
  let init
  if(domain==="upload"){const form=new FormData();for(const[k,v]of Object.entries({entryKind:"country",entryId:countryId,entryName:"SYNTHETIC OLD",folderId:targetId,folderPath:"B",...body}))form.set(k,String(v));form.set("file",new File(["SYNTHETIC ONLY"],"synthetic.txt"));init={method:"POST",body:form}}
  else init={method,headers:{"content-type":"application/json"},body:JSON.stringify(body)}
  const response=await loaded.exports[method](new Request("https://synthetic-app.invalid/api/ccinfo/"+file,init));return{status:response.status,body:await response.json(),cache:response.headers.get("cache-control")}
 }
 return{controls,calls,permissions,driveCalls,temp,request,payload,client}
}
