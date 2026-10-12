import assert from "node:assert/strict"
import test from "node:test"
import { authenticatedCreationActor, confirmPriceSetterAcknowledgement, confirmPriceSetterCreationState, validateOwnedPriceSetterCreation, validatePriceSetterAcknowledgement } from "../lib/priceSetterCreationRecovery"

const actorId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", requestId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const input={operation:"create",requestId,kind:"port",actorId,expectedVersion:"0"}

test("creation identity never falls back from a missing authenticated ID to a cached actor or username",()=>{
  for(const value of [null,undefined,"",false,{},[],"ADMIN","synthetic-user",{actorId}]) assert.throws(()=>authenticatedCreationActor(value),/Unauthorized/)
  assert.equal(authenticatedCreationActor(actorId.toUpperCase()),actorId)
})

test("owned creation accepts only exact identity-bound intentions and canonical bigint string revisions",()=>{
  assert.deepEqual(validateOwnedPriceSetterCreation({...input,requestId:requestId.toUpperCase(),actorId:actorId.toUpperCase()}),input)
  for(const v of ["0","1","9007199254740993","9223372036854775807"]) assert.equal(validateOwnedPriceSetterCreation({...input,expectedVersion:v}).expectedVersion,v)
  for(const v of [undefined,null,0,1,9007199254740992,"","00","01","-1","+1","1.0","1e2"," 1","1 ","9223372036854775808","99999999999999999999"]) assert.throws(()=>validateOwnedPriceSetterCreation({...input,expectedVersion:v}))
  for(const v of [null,[],{}, {operation:"create",requestId,kind:"port"}, {...input,actorId:null}, {...input,actorId:"bad"}, {...input,id:requestId}, {...input,hsfo:999}, {...input,kind:"PORT"}]) assert.throws(()=>validateOwnedPriceSetterCreation(v))
})

test("recovery state rejects damaged, cross-account or inconsistent replies rather than assuming no prior addition",()=>{
  const state={actorId,version:"1",pending:{requestId,kind:"divider"}}
  assert.deepEqual(confirmPriceSetterCreationState(state,actorId),state)
  assert.deepEqual(confirmPriceSetterCreationState({actorId,version:"9223372036854775807",pending:null}),{actorId,version:"9223372036854775807",pending:null})
  for(const bad of [null,[],{}, {...state,extra:true}, {...state,actorId:"bad"}, {...state,actorId:actorId.toUpperCase()}, {...state,version:1}, {...state,version:"01"},
    {...state,version:"0"},{...state,version:"9223372036854775808"},{...state,pending:[]},{...state,pending:{}},{...state,pending:{requestId,kind:"port",extra:true}},
    {...state,pending:{requestId:"bad",kind:"port"}},{...state,pending:{requestId:requestId.toUpperCase(),kind:"port"}},{...state,pending:{requestId,kind:"PORT"}}]) assert.throws(()=>confirmPriceSetterCreationState(bad))
  assert.throws(()=>confirmPriceSetterCreationState(state,requestId))
})

test("acknowledgement requires an exact actor/request pair and strictly confirmed response",()=>{
  const acknowledgement={actorId,requestId}
  assert.deepEqual(validatePriceSetterAcknowledgement({actorId:actorId.toUpperCase(),requestId:requestId.toUpperCase()}),acknowledgement)
  for(const bad of [null,[],{}, {...acknowledgement,actorId:null},{...acknowledgement,requestId:"bad"},{...acknowledgement,acknowledged:true},{...acknowledgement,operation:"delete"}]) assert.throws(()=>validatePriceSetterAcknowledgement(bad))
  assert.deepEqual(confirmPriceSetterAcknowledgement({...acknowledgement,acknowledged:true},acknowledgement),{...acknowledgement,acknowledged:true})
  for(const bad of [null,[],{}, {...acknowledgement,acknowledged:false},{...acknowledgement,acknowledged:"true"},{...acknowledgement,acknowledged:true,extra:true},
    {...acknowledgement,actorId:requestId,acknowledged:true},{...acknowledgement,requestId:actorId,acknowledged:true}]) assert.throws(()=>confirmPriceSetterAcknowledgement(bad,acknowledgement))
})
