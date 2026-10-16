import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { transformSync } from "esbuild"
import ts from "typescript"
import * as queryEscaping from "../lib/queryEscaping"

const entryId = "11111111-1111-4111-8111-111111111111"
const folderId = "22222222-2222-4222-8222-222222222222"
const version = "2026-10-14T01:00:00.123456Z"
const root = { id: folderId, folder_path: "", name: "A", updated_at: version }
const child = { id: "child", folder_path: "A", name: "EMPTY", updated_at: version }
const deep = { id: "deep", folder_path: "A/EMPTY", name: "DEEP", updated_at: version }
const unrelated = { id: "unrelated", folder_path: "A EXTRA", name: "UNCHANGED", updated_at: version }
const ack = {
  entryKind: "country", entryId, previousPath: "A", folderPath: "NEW",
  folders: [{ ...root, name: "NEW", updated_at: "2026-10-14T02:00:00.123456Z" }, { ...child, folder_path: "NEW" }, { ...deep, folder_path: "NEW/EMPTY" }],
  entryFiles: [{ id: "manual", folder_path: "NEW/EMPTY/DEEP", original_path: "country/SYNTHETIC/NEW/EMPTY/DEEP/manual.txt" }],
  companyFiles: [],
}
const routeSource = readFileSync(new URL("../app/api/ccinfo/files/route.ts", import.meta.url), "utf8")
const nodeRequire = createRequire(import.meta.url)

function routeFixture(error?: { code: string }, permission = "view") {
  const calls: unknown[] = []
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Object.assign(Response, { json: Response.json }) },
    "@/lib/queryEscaping": queryEscaping,
    "@/lib/ccinfoDrivePaths": {}, "@/lib/googleApis": {},
    "@/lib/adminAuth": { requireAdminPagePermission: async (...args: string[]) => { calls.push(args); if (permission === "anonymous") throw new Error("Unauthorized"); return { username: "TRUSTED VIEWER" } } },
    "@/lib/adminAudit": {
      createAdminAuditContext: (session: unknown, request: unknown, page: string) => ({ session, page }),
      createAdminAuditedSupabaseClient: (context: unknown, options: unknown) => {
        calls.push({ context, options })
        return {
          from() { assert.fail("Folder rename must not issue independent row mutations") },
          async rpc(name: string, params: unknown) { calls.push({ name, params }); return { data: ack, error: error || null } },
        }
      },
    },
  }
  const loaded: { exports: { PATCH?: (request: Request) => Promise<Response> } } = { exports: {} }
  const code = transformSync(routeSource, { loader: "ts", format: "cjs", target: "node24" }).code
  new Function("require", "module", "exports", code)((name: string) => name.startsWith("node:") ? nodeRequire(name) : modules[name], loaded, loaded.exports)
  return { calls, request: (changes = {}) => loaded.exports.PATCH!(new Request("https://synthetic.invalid/api/ccinfo/files", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "renameFolder", entryKind: "country", entryId, folderId, folderPath: "A", name: "NEW", expectedUpdatedAt: version, entryName: "FORGED UNUSED LABEL", ...changes }),
  })) }
}

test("folder route retains collaborative view permission and sends one narrowly audited RPC", async () => {
  const fixture = routeFixture()
  const response = await fixture.request()
  assert.equal(response.status,200)
  assert.deepEqual(await response.json(),{ok:true,rename:ack})
  assert.deepEqual(fixture.calls,[
    ["ccinfo","view"],
    {context:{session:{username:"TRUSTED VIEWER"},page:"ccinfo"},options:{useServiceRole:true}},
    {name:"rename_ccinfo_folder",params:{p_entry_kind:"country",p_entry_id:entryId,p_folder_id:folderId,p_folder_path:"A",p_expected_updated_at:version,p_name:"NEW"}},
  ])
})

test("folder route supports implied folders without accepting forged IDs, invalid names or missing saved versions", async () => {
  const virtual=routeFixture()
  assert.equal((await virtual.request({folderId:"virtual:A",expectedUpdatedAt:null})).status,200)
  assert.equal((virtual.calls.at(-1) as {params:{p_folder_id:null}}).params.p_folder_id,null)
  for (const changes of [{folderId:"virtual:OTHER"},{expectedUpdatedAt:null},{entryKind:"unknown"},{entryId:"bad"},{name:"A/B"},{name:"A\\B"},{name:"BAD\nNAME"},{name:"X".repeat(201)}]) {
    const fixture=routeFixture()
    assert.equal((await fixture.request(changes)).status,400)
    assert.equal(fixture.calls.length,2)
  }
})

test("folder route reports rejected conflicts/failures without acknowledging any partial success", async () => {
  for (const [code,status] of [["40001",409],["23505",409],["40P01",409],["55P03",409],["22023",400],["XX000",500]] as const) {
    const response=await routeFixture({code}).request()
    assert.equal(response.status,status)
    assert.equal((await response.json()).ok,undefined)
  }
})

const pageSource=readFileSync(new URL("../app/admin/ccinfo/page.tsx",import.meta.url),"utf8")
const handlerNames=["beginFileMutation","applyFolderRelocation","renameFolder","uploadFiles","moveFolderToPath","moveFileToFolder"]
const handlerCode=handlerNames.map(name=>{
  const start=pageSource.indexOf(`  ${["beginFileMutation","applyFolderRelocation"].includes(name)?"":"async "}function ${name}(`)
  const end=pageSource.indexOf("\n  }",start)+4
  assert.ok(start>=0&&end>start)
  return ts.transpileModule(pageSource.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
}).join("\n")

function pageFixture() {
  const owner={current:1}
  const files=[{id:"manual",source:"entry",folder_path:"A/EMPTY/DEEP",file_name:"manual.txt"},{id:"unrelated-file",source:"entry",folder_path:"A EXTRA",file_name:"unchanged.txt"}]
  type State = { files: typeof files; deletedFiles: typeof files; folders: typeof root[]; currentFolderPath: string; selectedPreviewFile: typeof files[number] | null; editor: typeof root | null; message: string }
  const state: State={files,deletedFiles:[],folders:[root,child,deep,unrelated],currentFolderPath:"A/EMPTY/DEEP",selectedPreviewFile:files[0],editor:root,message:""}
  let release:()=>void=()=>{}
  let status=200
  let invalid=false
  let requests=0
  let refreshes=0
  let uploadRelease:()=>void=()=>{}
  const locks={current:new Set<string>()}
  const deleting={current:false}
  const set=<K extends keyof State>(key:K)=>(next:State[K]|((previous:State[K])=>State[K]))=>{state[key]=typeof next==="function"?next(state[key]):next}
  const deps: Record<string,unknown>={
    window:{prompt:()=>"NEW"},joinFolderPath:(path:string,name:string)=>[path,name].filter(Boolean).join("/"),recordOwnerRef:owner,
    fileMutationLocksRef:locks,filePanelRefreshGenerationRef:{current:0},recordLoading:false,renderOwner:1,recordDeletePendingRef:deleting,
    selectedKind:"country",selectedId:entryId,currentRecord:{name:"SYNTHETIC"},files,
    fetch:async (_url:string,request:{body:string})=>{
      requests+=1
      const body=JSON.parse(request.body)
      if(body.action==="renameFolder"||body.action==="moveFolder") assert.equal(body.expectedUpdatedAt,version)
      await new Promise<void>(resolve=>{release=resolve})
      return Response.json(status===200?invalid?{ok:true,rename:null}:body.action==="move"?{ok:true,file:{id:"manual",source:"entry"}}:{ok:true,rename:ack,move:ack}:{message:"Collision; no changes saved"},{status})
    },
    setFilePanelData:(next:Partial<State>|((previous:State)=>Partial<State>))=>Object.assign(state,typeof next==="function"?next(state):next),
    setFiles:set("files"),setDeletedFiles:set("deletedFiles"),setFolders:set("folders"),setCurrentFolderPath:set("currentFolderPath"),setSelectedPreviewFile:set("selectedPreviewFile"),setFilePanelEditTarget:set("editor"),setMessage:set("message"),loadRecentAuditLogs:async()=>{},
    mergeFolderRecords:(folders:typeof root[])=>folders,
    canMoveFolderToPath:()=>true,targetFolderId:()=>folderId,
    DIRECT_DRIVE_UPLOAD_THRESHOLD_BYTES:1024,uploadLargeFile:()=>assert.fail("only synthetic small files"),
    uploadSmallFile:async()=>{await new Promise<void>(resolve=>{uploadRelease=resolve});return{file:{id:"uploaded",source:"entry",folder_path:"A",file_name:"uploaded.txt"}}},
    refreshFilePanel:async()=>{refreshes+=1;return true},addSimpleChangeLog:()=>{},changeLogSubject:()=>"SYNTHETIC",setUploadingFile:()=>{},setFilePanelDropPath:()=>{},setDraggingFileId:()=>{},setDraggingFolderPath:()=>{},setDropFolderPath:()=>{},
  }
  const handlers=new Function(...Object.keys(deps),`${handlerCode}; return {rename:renameFolder,upload:uploadFiles,moveFolder:moveFolderToPath,moveFile:moveFileToFolder}`)(...Object.values(deps)) as {
    rename:(folder:typeof root,name:string)=>Promise<void>;upload:(files:File[],path:string)=>Promise<void>;
    moveFolder:(folder:typeof root,path:string)=>Promise<void>;moveFile:(file:typeof files[number],path:string)=>Promise<void>
  }
  return {state,owner,...handlers,release:()=>release(),releaseUpload:()=>uploadRelease(),fail:()=>{status=409},invalid:()=>{invalid=true},requests:()=>requests,refreshes:()=>refreshes,locks,deleting}
}

test("a pending record deletion blocks file mutations before issuing requests",async()=>{
  const f=pageFixture()
  f.deleting.current=true
  await f.rename(root,"NEW")
  assert.equal(f.requests(),0)
  assert.equal(f.locks.current.size,0)
  assert.deepEqual(f.state.folders,[root,child,deep,unrelated])
})

test("client installs authoritative direct/deep folder versions, file/preview paths and current descendant location", async () => {
  const f=pageFixture(),pending=f.rename(root,"NEW")
  assert.deepEqual(f.state.folders,[root,child,deep,unrelated])
  f.release(); await pending
  assert.deepEqual(f.state.folders,[...ack.folders,unrelated])
  assert.equal(f.state.files[0].folder_path,"NEW/EMPTY/DEEP")
  assert.equal(f.state.files[1].folder_path,"A EXTRA")
  assert.equal(f.state.selectedPreviewFile?.folder_path,"NEW/EMPTY/DEEP")
  assert.equal(f.state.currentFolderPath,"NEW/EMPTY/DEEP")
  assert.equal(f.state.editor,null)
})

test("client keeps folder editor/data after rejection and ignores a previous entry's late success", async () => {
  for(const switchEntry of [false,true]) {
    const f=pageFixture()
    if(!switchEntry) f.fail()
    const pending=f.rename(root,"NEW")
    if(switchEntry) f.owner.current+=1
    f.release(); await pending
    assert.deepEqual(f.state.folders,[root,child,deep,unrelated])
    assert.equal(f.state.currentFolderPath,"A/EMPTY/DEEP")
    assert.equal(f.state.editor,root)
  }
})

test("delayed rename reconciles current additions/deletions rather than replacing a captured file array",async()=>{
  const f=pageFixture(),pending=f.rename(root,"NEW")
  f.state.files=f.state.files.filter(file=>file.id!=="manual")
  f.state.files.push({id:"concurrent-upload",source:"entry",folder_path:"ELSEWHERE",file_name:"new.txt"})
  f.release();await pending
  assert.deepEqual(f.state.files.map(file=>file.id),["unrelated-file","concurrent-upload"])
})

test("late failure and invalid acknowledgement after entry switch do not change the next entry's message or editor",async()=>{
  for(const invalid of [false,true]) {
    const f=pageFixture()
    if(invalid)f.invalid();else f.fail()
    const pending=f.rename(root,"NEW")
    f.owner.current+=1
    f.state.message="NEXT ENTRY MESSAGE"
    f.release();await pending
    assert.equal(f.state.message,"NEXT ENTRY MESSAGE")
    assert.equal(f.state.editor,root)
    assert.equal(f.locks.current.size,0)
  }
})

test("a held upload excludes a same-entry relocation while navigation remains responsive",async()=>{
  const f=pageFixture(),pending=f.upload([new File(["SYNTHETIC"],"uploaded.txt")],"A")
  await f.rename(root,"NEW")
  assert.equal(f.requests(),0)
  assert.match(f.state.message,/wait for the current file change/)
  f.owner.current+=1
  f.state.message="NEXT ENTRY"
  f.releaseUpload();await pending
  assert.equal(f.refreshes(),0)
  assert.equal(f.state.message,"NEXT ENTRY")
  assert.equal(f.locks.current.size,0)
})

test("held file and folder moves ignore success/failure after navigation without rolling old files into the new entry",async()=>{
  for(const folder of [false,true])for(const failed of [false,true]) {
    const f=pageFixture()
    if(failed)f.fail()
    const pending=folder?f.moveFolder(root,"DESTINATION"):f.moveFile(f.state.files[0],"DESTINATION")
    f.owner.current+=1
    f.state.files=[{id:"next-entry-file",source:"entry",folder_path:"",file_name:"next.txt"}]
    f.state.message="NEXT ENTRY"
    f.release();await pending
    assert.deepEqual(f.state.files.map(file=>file.id),["next-entry-file"])
    assert.equal(f.state.message,"NEXT ENTRY")
    assert.equal(f.refreshes(),0)
  }
})
