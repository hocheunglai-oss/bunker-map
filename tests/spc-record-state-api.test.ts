import assert from "node:assert/strict"
import test from "node:test"
import { createRecordStateRoute, recordStateMemory, reviewPayload, presentationRow, stateActor } from "./fixtures/spc-record-state-api.mjs"

test("lost review requires the exact browser baseline, preserving a colleague's newer review",async()=>{
  const db=recordStateMemory(),app=createRecordStateRoute({createClient:db.client})
  const latest=await app.mutate(reviewPayload())
  assert.equal(latest.status,200);assert.equal(latest.body.review.meta.spcComments,"Verified comment")
  const before=structuredClone(db.rows)
  const stale=await app.mutate(reviewPayload({supplierLostReason:"",supplierLostReasonDetails:"",spcComments:"Stale comment"}))
  assert.equal(stale.status,409);assert.match(stale.body.message,/draft is kept.*Refresh/);assert.deepEqual(db.rows,before);assert.equal(db.writes.length,1)
  const again=await app.mutate(reviewPayload({expectedUpdatedAt:latest.body.review.updatedAt,spcComments:"Next verified comment"}))
  assert.equal(again.status,200);assert.equal(again.body.review.meta.spcComments,"Next verified comment")
})
test("missing/malformed old-client baselines fail closed before data access",async()=>{
  for(const expectedUpdatedAt of [undefined,"","not-a-date",true,"2026-99-99T00:00:00Z"]){
    const db=recordStateMemory(),app=createRecordStateRoute({createClient:db.client}),response=await app.mutate(reviewPayload({expectedUpdatedAt}))
    assert.equal(response.status,409);assert.equal(db.headers.length,0);assert.equal(db.writes.length,0)
  }
})
test("lost review preserves the existing role/view permission policy and validates reasons",async()=>{
  for(const [actor,permission,status] of [[null,"edit",401],[stateActor,"none",403],[{...stateActor,role:"BUYER TRADER"},"view",403]] as const){
    const db=recordStateMemory(),response=await createRecordStateRoute({createClient:db.client,actor,permission}).mutate(reviewPayload())
    assert.equal(response.status,status);assert.equal(db.writes.length,0)
  }
  const db=recordStateMemory(),app=createRecordStateRoute({createClient:db.client,permission:"view",actor:{...stateActor,role:"SUPPLIER TRADER"}})
  assert.equal((await app.mutate(reviewPayload({supplierLostReason:"INVALID"}))).status,400)
  assert.equal((await app.mutate(reviewPayload())).status,200)
  assert.equal(db.headers.at(-1)?.["x-bunker-audit-actor-user-id"],stateActor.userId)
})
test("lost review checks status and browser version again at the final DML boundary",async()=>{
  const db=recordStateMemory({beforeWrite:async()=>{db.rows.spc_enquiries[0].status="sent"}})
  const response=await createRecordStateRoute({createClient:db.client}).mutate(reviewPayload())
  assert.equal(response.status,409);assert.equal(db.writes.length,0)
  assert.equal(db.rows.spc_enquiries[0].notes,"SYNTHETIC VESSEL / Singapore / VLSFO 500mts")
})
test("presentation deletion rejects stale/legacy clients, permissions and missing rows without touching media",async()=>{
  for(const revision of [undefined,0,-1,1.5,"1",NaN,2]){
    const db=recordStateMemory(),response=await createRecordStateRoute({kind:"presentation",createClient:db.client}).mutate({action:"delete",id:presentationRow.id,revision})
    assert.equal(response.status,409);assert.equal(db.rows.spc_presentation_chunks.length,1);assert.equal(db.removes.length,0)
  }
  for(const [actor,permission,status] of [[null,"edit",401],[stateActor,"view",403]] as const){
    const db=recordStateMemory(),response=await createRecordStateRoute({kind:"presentation",createClient:db.client,actor,permission}).mutate({action:"delete",id:presentationRow.id,revision:1})
    assert.equal(response.status,status);assert.equal(db.writes.length,0);assert.equal(db.removes.length,0)
  }
})
test("presentation deletion uses one exact revision DELETE while preserving physical media; retries do not mutate again",async()=>{
  const db=recordStateMemory(),app=createRecordStateRoute({kind:"presentation",createClient:db.client}),payload={action:"delete",id:presentationRow.id,revision:1}
  assert.equal((await app.mutate(payload)).status,200);assert.equal(db.writes.length,1)
  assert.deepEqual(db.writes[0].filters,[["id",presentationRow.id],["revision",1]])
  assert.deepEqual(db.removes,[])
  assert.equal((await app.mutate(payload)).status,409);assert.equal(db.writes.length,1);assert.equal(db.removes.length,0)
})
test("presentation delete cannot remove a revision updated just before its DML",async()=>{
  const db=recordStateMemory({beforeWrite:async()=>{db.rows.spc_presentation_chunks[0].revision=2;db.rows.spc_presentation_chunks[0].video_path="new-media.mp4"}})
  const response=await createRecordStateRoute({kind:"presentation",createClient:db.client}).mutate({action:"delete",id:presentationRow.id,revision:1})
  assert.equal(response.status,409);assert.equal(db.rows.spc_presentation_chunks[0].revision,2);assert.equal(db.removes.length,0)
})
test("media attachment lost-ack retry replays only the exact path/MIME/resulting revision without repeating cleanup or mutation",async()=>{
  const db=recordStateMemory({loseMediaAck:true}),app=createRecordStateRoute({kind:"presentation",createClient:db.client})
  const payload={action:"complete-upload",id:presentationRow.id,revision:1,kind:"video",path:presentationRow.id+"/video-new.mp4",mimeType:"video/mp4"}
  assert.equal((await app.mutate(payload)).status,500)
  assert.equal(db.rows.spc_presentation_chunks[0].revision,2);assert.equal(db.rows.spc_presentation_chunks[0].video_path,payload.path);assert.equal(db.rows.spc_presentation_chunks[0].video_bytes,123)
  const committed=structuredClone(db.rows),writes=db.writes.length,removes=structuredClone(db.removes)
  const replay=await app.mutate(payload)
  assert.equal(replay.status,200);assert.equal(replay.body.chunk.revision,2);assert.equal(replay.body.chunk.videoBytes,123);assert.equal(replay.body.chunk.videoPath,payload.path);assert.equal(replay.body.chunk.videoMimeType,payload.mimeType)
  assert.deepEqual(db.rows,committed);assert.equal(db.writes.length,writes);assert.deepEqual(db.removes,removes)
  assert.equal((await app.mutate({...payload,path:presentationRow.id+"/video-other.mp4"})).status,409)
  assert.equal((await app.mutate({...payload,mimeType:"video/webm"})).status,409)
  db.rows.spc_presentation_chunks[0].revision=3
  assert.equal((await app.mutate(payload)).status,409);assert.equal(db.writes.length,writes);assert.deepEqual(db.removes,removes)
})
test("unknown MIME is rejected before uploading under existing policy, and legacy null media version retains Number normalization",async()=>{
  const db=recordStateMemory(),app=createRecordStateRoute({kind:"presentation",createClient:db.client})
  assert.equal((await app.mutate({action:"prepare-upload",id:presentationRow.id,kind:"video",fileName:"unknown",fileBytes:24,mimeType:""})).status,400);assert.equal(db.writes.length,0)
  Reflect.set(db.rows.spc_presentation_chunks[0],"media_version",null)
  const attached=await app.mutate({action:"complete-upload",id:presentationRow.id,revision:1,kind:"video",path:presentationRow.id+"/video-new.mp4",mimeType:"video/mp4"})
  assert.equal(attached.status,200);assert.equal(attached.body.chunk.mediaVersion,1)
})
test("narration completion/replay preserves the existing video and verifies the narration branch",async()=>{
  const db=recordStateMemory({loseMediaAck:true}),app=createRecordStateRoute({kind:"presentation",createClient:db.client}),payload={action:"complete-upload",id:presentationRow.id,revision:1,kind:"narration",path:presentationRow.id+"/narration-new.mp3",mimeType:"audio/mpeg"}
  assert.equal((await app.mutate(payload)).status,500)
  const replay=await app.mutate(payload);assert.equal(replay.status,200);assert.equal(replay.body.chunk.narrationPath,payload.path);assert.equal(replay.body.chunk.narrationMimeType,payload.mimeType);assert.equal(replay.body.chunk.narrationBytes,123);assert.equal(replay.body.chunk.videoPath,presentationRow.video_path)
  assert.equal(db.writes.length,1);assert.deepEqual(db.removes,[])
})
