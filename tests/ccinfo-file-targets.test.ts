import assert from "node:assert/strict"
import test from "node:test"
import { prepareCcinfoFileTarget, registerCcinfoUploadedFile, type CcinfoFileTarget } from "../lib/ccinfoDrivePaths"

const entryId="11111111-1111-4111-8111-111111111111"
const folderId="22222222-2222-4222-8222-222222222222"
const prepared: CcinfoFileTarget={entryKind:"company",entryId,entryName:"SYNTHETIC",folderId,folderPath:"A"}

test("upload target helper retains stable identity and final registration never sends a stale folder path",async()=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[]
  const client={rpc:async(name:string,args:Record<string,unknown>)=>{
    calls.push({name,args})
    return {error:null,data:name==="prepare_ccinfo_file_target"?prepared:{id:"file",source:"entry",folder_path:"B",file_name:"late.txt",file_type:"TXT",drive_file_id:"SYNTHETIC-DRIVE",drive_url:"https://synthetic.invalid/file"}}
  }}
  const target=await prepareCcinfoFileTarget(client,"company",entryId,"A",folderId)
  const file=await registerCcinfoUploadedFile(client,target,{name:"late.txt",type:"TXT",driveId:"SYNTHETIC-DRIVE",url:"https://synthetic.invalid/file"})
  assert.equal(file.folder_path,"B")
  assert.deepEqual(calls[1],{name:"register_ccinfo_file",args:{p_entry_kind:"company",p_entry_id:entryId,p_folder_id:folderId,p_file_name:"late.txt",p_file_type:"TXT",p_drive_file_id:"SYNTHETIC-DRIVE",p_drive_url:"https://synthetic.invalid/file"}})
  assert.equal(Object.hasOwn(calls[1].args,"p_folder_path"),false)
})

test("target helper rejects wrong entry/unstable non-home destinations and preserves uploaded content on unconfirmed registration",async()=>{
  for(const data of [null,{}, {...prepared,entryId:"OTHER"},{...prepared,folderId:null}]) {
    await assert.rejects(prepareCcinfoFileTarget({rpc:async()=>({data,error:null})},"company",entryId,"A",folderId),/could not be confirmed/)
  }
  for(const result of [{data:null,error:{code:"40001"}},{data:{id:"file",drive_file_id:"WRONG"},error:null}]) {
    await assert.rejects(registerCcinfoUploadedFile({rpc:async()=>result},prepared,{name:"late.txt",type:"TXT",driveId:"PRESERVED",url:"https://synthetic.invalid/file"}),/uploaded Drive file has been preserved/)
  }
})
