import assert from "node:assert/strict"
import test from "node:test"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { createClient } from "@supabase/supabase-js"
import { literal, setupNativeCcinfo } from "./fixtures/native-postgres-ccinfo.mjs"
import { readAuditBrowsingBatch, loadAuditBrowsingPortNames, loadAuditBrowsingUserNames } from "../lib/auditBrowsingSource.ts"
import { compareAuditBrowsePositions, auditBrowseDigest, startAuditBrowseGeneration } from "../lib/auditBrowsingCursor.ts"
import { createAuditBrowsingTransport } from "../lib/auditBrowsingTransport.ts"
import { scanAuditBrowsePage } from "../lib/auditBrowsing.ts"
import { AUDIT_BROWSING_INDEX_SELECT, AUDIT_SELECT, mapAuditLog, presentAuditLogs } from "../lib/auditLog.ts"

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sha = value => createHash("sha256").update(value).digest("hex")
const releaseArchiveSha = "5720fbde4a19ade9fb189791615c84beb9f0e58201b1b6d17fe3b698faf60776"
const releaseBinarySha = "325628d6bc975251c2952c1275e969b8dc57f88db32dfb82c4c6597cebcd260b"
const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`
const universe = `(table_schema='public' or (table_schema='app' and table_name in ('outlook_template_insertion_attempts','spc_user_management_events','spc_mfa_test_events'))) and actor_source in ('app','header')`
const compactMigrationPath = "supabase/migrations/20261020043800_compact_audit_browsing_template_rows.sql"
const compactMigration = readFileSync(join(root, compactMigrationPath), "utf8")
const fixtureSql = `
create role service_role nologin nobypassrls;
create role anon nologin nobypassrls;
create role authenticated nologin nobypassrls;
grant usage on schema public to service_role;
grant usage on schema public to anon,authenticated;
create table public.audit_logs (
  id uuid primary key, occurred_at timestamptz not null,
  actor_user_id uuid, actor_id text, actor_name text, actor_source text not null,
  table_schema text not null, table_name text not null, operation text not null,
  record_pk jsonb, changed_fields text[], before_row jsonb, after_row jsonb,
  request_context jsonb, undo_of_log_id uuid, undone_at timestamptz, undone_by_log_id uuid
);
create table public.ports (id integer primary key, name text not null);
create table public.admin_users (id uuid primary key, username text not null, display_name text);
create table public.spc_users (id uuid primary key, username text not null, display_name text);
-- Only the owned snapshot test uses this RLS gate. A real PostgREST SELECT
-- blocks AFTER obtaining its statement snapshot; another owned backend can
-- then commit one synthetic insert before the same statement resumes.
create function public.audit_snapshot_gate() returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
  if coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb ->> 'x-synthetic-audit-gate' = '1' then
    perform pg_advisory_xact_lock(81813);
  end if;
  return true;
end $$;
revoke all on function public.audit_snapshot_gate() from public;
grant execute on function public.audit_snapshot_gate() to service_role;
alter table public.audit_logs enable row level security;
create policy owned_audit_read on public.audit_logs for select to service_role using (public.audit_snapshot_gate());
grant select on public.audit_logs,public.ports,public.admin_users,public.spc_users to service_role;
-- Browser roles can see the table name but have no row policy and cannot
-- execute either computed field. This deliberately exercises both barriers.
grant select on public.audit_logs to anon,authenticated;
insert into public.audit_logs
select ('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text,12,'0'))::uuid,
  '2026-10-20T01:00:00Z'::timestamptz - (n/4)*interval '1 second' + (n%2)*interval '1 microsecond',
  null,'synthetic@example.invalid','Synthetic User',case when n%2=0 then 'app' else 'header' end,
  'public','office_calendar_store','UPDATE',jsonb_build_object('key',case when n>=78 then 'event-calendar' else 'task-calendar' end),
  array['payload'],jsonb_build_object('key',case when n>=78 then 'event-calendar' else 'task-calendar' end),
  case when n=10 then '{}'::jsonb else jsonb_build_object('key',case when n>=78 then 'event-calendar' else 'task-calendar' end) end,
  jsonb_build_object('pageId',case when n>=78 then 'event-calendar' else 'task-calendar' end),null,null,null
from generate_series(1,80) n;
insert into public.audit_logs (id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,after_row,request_context) values
('${id(1001)}','2026-10-20T09:00:00.123456+08:00','synthetic@example.invalid','Synthetic User','app','public','office_calendar_store','UPDATE','{"key":"task-calendar"}','{}','{"key":"task-calendar"}','{"pageId":"task-calendar"}'),
('${id(1002)}','2026-10-20T01:00:00.123456+00:00','synthetic@example.invalid','Synthetic User','header','public','office_calendar_store','UPDATE','{"key":"task-calendar"}','{}','{"key":"task-calendar"}','{"pageId":"task-calendar"}'),
('${id(1003)}','2026-10-20T01:00:00.123455Z','synthetic@example.invalid','Synthetic User','app','public','office_calendar_store','UPDATE','{"key":"task-calendar"}','{}','{"key":"task-calendar"}','{"pageId":"task-calendar"}'),
('${id(1004)}','2026-10-19T01:00:00Z','spc:synthetic@example.invalid','Synthetic User','app','app','spc_user_management_events','INSERT','{}','{}','{}','{"pageId":"spc-user-management"}'),
('${id(9001)}','2026-10-18T01:00:00Z','synthetic@example.invalid','Excluded Schema','app','private','office_calendar_store','UPDATE','{}','{}','{}','{}'),
('${id(9002)}','2026-10-18T01:00:01Z','synthetic@example.invalid','Excluded App Table','app','app','not_an_allowed_table','UPDATE','{}','{}','{}','{}'),
('${id(9003)}','2026-10-21T01:00:00Z','synthetic@example.invalid','Excluded Source','unknown','public','office_calendar_store','UPDATE','{}','{}','{}','{}');
insert into public.ports select n,'SYNTHETIC PORT '||n from generate_series(1,39) n;
insert into public.spc_users select ('bbbbbbbb-bbbb-4bbb-8bbb-'||lpad(n::text,12,'0'))::uuid,'spc-'||n||'@example.invalid','SPC USER '||n from generate_series(1,31) n;
insert into public.admin_users select ('cccccccc-cccc-4ccc-8ccc-'||lpad(n::text,12,'0'))::uuid,'admin-'||n||'@example.invalid','ADMIN USER '||n from generate_series(1,35) n;
create index audit_order_fixture on public.audit_logs (occurred_at desc,id desc);
`

async function vacantLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startPostgrest(cluster, runtime, cap, runtimeEnvironment, role = "service_role", schemaNotifications = false) {
  const port = await vacantLoopbackPort()
  const origin = `http://127.0.0.1:${port}`
  const uri = new URL("postgresql:///postgres")
  uri.searchParams.set("host", cluster.socket)
  uri.searchParams.set("port", "55489")
  uri.searchParams.set("user", "fcuno_ccinfo_fixture_owner")
  uri.searchParams.set("application_name", "fcuno_owned_audit_postgrest")
  assert.equal(uri.searchParams.get("host"), cluster.socket)
  const child = spawn(runtime, [], { env: {
    ...runtimeEnvironment, PGPASSFILE: join(cluster.root, "no-personal-password-file"),
    PGRST_DB_URI: uri.toString(), PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: role,
    PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(port), PGRST_DB_MAX_ROWS: String(cap),
    PGRST_DB_POOL: "3", PGRST_DB_CHANNEL_ENABLED: String(schemaNotifications), PGRST_LOG_LEVEL: "warn",
  }, stdio: ["ignore", "pipe", "pipe"] })
  let log = "", closed = false
  child.stdout.on("data", data => { log = (log + data).slice(-32768) })
  child.stderr.on("data", data => { log = (log + data).slice(-32768) })
  const done = new Promise(resolve => {
    child.once("error", error => { closed = true; resolve({ error: error.message }) })
    child.once("close", (code, signal) => { closed = true; resolve({ code, signal }) })
  })
  async function close() {
    if (!closed) child.kill("SIGTERM")
    const timer = setTimeout(() => { if (!closed) child.kill("SIGKILL") }, 5000)
    try { return await done } finally { clearTimeout(timer) }
  }
  try {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (closed) throw new Error(`Owned PostgREST startup failed: ${log}`)
      try {
        const response = await fetch(`${origin}/audit_logs?select=id&limit=0`, { signal: AbortSignal.timeout(500), redirect: "error" })
        await response.arrayBuffer()
        if (response.ok) break
      } catch { /* An owned process may still be initializing its schema cache. */ }
      if (Date.now() >= deadline) throw new Error(`Owned PostgREST health deadline: ${log}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return { origin, pid: child.pid, close, cap }
  } catch (error) { await close(); throw error }
}

function sdkFor(server, captures, extraHeaders = {}) {
  const transport = createAuditBrowsingTransport(undefined, { deadlineMs: 8000, fetcher: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.equal(url.origin, server.origin, "No request may leave the owned loopback server")
    // Supabase's HTTP gateway owns this prefix; the official bare PostgREST
    // process starts at /. Only the owned loopback adapter removes it.
    assert.ok(url.pathname.startsWith("/rest/v1/"))
    url.pathname = url.pathname.slice("/rest/v1".length)
    assert.ok(["/audit_logs", "/ports", "/admin_users", "/spc_users"].includes(url.pathname))
    assert.equal((init?.method || "GET").toUpperCase(), "GET")
    const headers = new Headers(init?.headers)
    headers.delete("authorization"); headers.delete("apikey")
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
    const response = await fetch(url, { ...init, headers, redirect: "error" })
    const capture = { path: url.pathname, query: url.search, prefer: headers.get("prefer"), range: response.headers.get("content-range"), status: response.status, bytes: 0 }
    captures.push(capture)
    const body = response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) { capture.bytes += chunk.byteLength; controller.enqueue(chunk) } }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  } })
  const client = createClient(server.origin, "synthetic-local-only", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transport.fetch } })
  return { client, finish: transport.finish }
}

async function verifyCompactProjection(cluster, runtime, runtimeEnvironment, servers, evidence) {
  const server = await startPostgrest(cluster, runtime, 250, runtimeEnvironment, "service_role", true)
  servers.push(server)
  const compactUrl = `${server.origin}/audit_logs?select=id,before_row:audit_browsing_before_row&limit=1`
  const beforeMigration = await fetch(compactUrl)
  assert.equal(beforeMigration.ok, false)
  await beforeMigration.arrayBuffer()
  await cluster.owner.query(`begin;\n${compactMigration}\ncommit;`)
  let cacheReloadObserved = false
  const cacheDeadline = Date.now() + 5000
  while (Date.now() < cacheDeadline) {
    const response = await fetch(compactUrl)
    await response.arrayBuffer()
    if (response.ok) { cacheReloadObserved = true; break }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(cacheReloadObserved, true, "Migration NOTIFY reloads the already running PostgREST computed-field cache")
  const acl = await cluster.owner.one(`select jsonb_build_object('rows',jsonb_agg(jsonb_build_object(
    'name',p.proname,'immutable',p.provolatile='i','invoker',not p.prosecdef,
    'unnamed',p.proargnames is null,'settings',p.proconfig,
    'anon',has_function_privilege('anon',p.oid,'execute'),
    'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
    'service',has_function_privilege('service_role',p.oid,'execute')) order by p.proname))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('audit_browsing_before_row','audit_browsing_after_row');`)
  assert.equal(acl.rows.length, 2)
  for (const fn of acl.rows) {
    assert.equal(fn.immutable, true); assert.equal(fn.invoker, true); assert.equal(fn.unnamed, true)
    assert.ok(fn.settings.includes('search_path=""'))
    assert.equal(fn.anon, false); assert.equal(fn.authenticated, false); assert.equal(fn.service, true)
  }
  const shapes = [null, "null", "{}", '"scalar"', "17", "true", "false", '[]', '[{"body_html":"keep nested"}]',
    '{"body_html":"omit","body_text":"omit","source":"spc","id":0,"key":null,"unknown":{"body_html":"keep nested"}}']
  const shapeIds = shapes.map((_, index) => id(20001 + index))
  for (let index = 0; index < shapes.length; index++) {
    const value = shapes[index] === null ? "NULL" : literal(shapes[index]) + "::jsonb"
    await cluster.owner.query(`insert into public.audit_logs(id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
      values('${shapeIds[index]}','2026-10-23T01:00:00.123456Z','synthetic@example.invalid','Synthetic User','app','public','email_templates','UPDATE','{}',array['body_html'],${value},${value},'{"pageId":"email-templates"}');`)
  }
  for (const [number, schema, table] of [[20100,"public","office_calendar_store"],[20101,"app","email_templates"]]) {
    shapeIds.push(id(number))
    await cluster.owner.query(`insert into public.audit_logs(id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
      values('${id(number)}','2026-10-23T01:00:00.123456Z','synthetic@example.invalid','Synthetic User','app','${schema}','${table}','UPDATE','{}','{}','{"body_html":"KEEP","body_text":"KEEP","source":"spc"}','{"body_html":"KEEP","body_text":"KEEP","source":"spc"}','{"pageId":"email-templates"}');`)
  }
  const shapeProof = await cluster.owner.one(`select jsonb_build_object('count',count(*),'equal',bool_and(
    public.audit_browsing_before_row(a) is not distinct from case when table_schema='public' and table_name='email_templates' and jsonb_typeof(before_row)='object' then before_row-'body_html'-'body_text' else before_row end
    and public.audit_browsing_after_row(a) is not distinct from case when table_schema='public' and table_name='email_templates' and jsonb_typeof(after_row)='object' then after_row-'body_html'-'body_text' else after_row end),
    'sqlNull',bool_and(case when id='${id(20001)}' then public.audit_browsing_before_row(a) is null else true end),
    'jsonNull',bool_and(case when id='${id(20002)}' then public.audit_browsing_before_row(a)='null'::jsonb else true end))
    from public.audit_logs a where id in (${shapeIds.map(literal).join(",")});`)
  assert.equal(shapeProof.count, shapeIds.length); assert.equal(shapeProof.equal, true)
  assert.equal(shapeProof.sqlNull, true); assert.equal(shapeProof.jsonNull, true)
  const shapeCaptures = [], shapeReader = sdkFor(server, shapeCaptures)
  try {
    const raw = await shapeReader.client.from("audit_logs").select(AUDIT_SELECT, {count:"exact"}).in("id",shapeIds).order("id")
    const compact = await shapeReader.client.from("audit_logs").select(AUDIT_BROWSING_INDEX_SELECT, {count:"exact"}).in("id",shapeIds).order("id")
    assert.equal(raw.error, null); assert.equal(compact.error, null); assert.equal(compact.count, shapeIds.length)
    const [rawPresented, compactPresented] = await Promise.all([raw.data, compact.data].map(rows => presentAuditLogs(rows.map(mapAuditLog), [], {portNames:new Map(),client:shapeReader.client,includeDetails:false})))
    const index = records => records.map(({id,occurredAt,actorId,actorName,operation,displayOperation,pageId,pageLabel,recordLabel,summary,undoable,undoOfLogId,undoneAt,details}) => ({id,occurredAt,actorId,actorName,operation,displayOperation,pageId,pageLabel,recordLabel,summary,undoable,undoOfLogId,undoneAt,details}))
    assert.deepEqual(index(compactPresented), index(rawPresented), "Compact native JSON and full raw rows give identical ordinary canonical index logs")
    assert.ok(compact.data.some(row => row.after_row?.source === "spc"))
  } finally { shapeReader.finish() }
  const compactProviderCaps=[]
  for(const cap of [17,1]){
    const capped=await startPostgrest(cluster,runtime,cap,runtimeEnvironment)
    servers.push(capped)
    const expected=await cluster.owner.one(`select jsonb_build_object('ids',(select jsonb_agg(id order by occurred_at desc,id desc) from public.audit_logs where ${universe}));`)
    const captures=[],reader=sdkFor(capped,captures),seen=[]
    let after=null,exhausted=false
    try{
      for(let attempt=0;attempt<200;attempt++){
        const page=await readAuditBrowsingBatch(reader.client,after,250,{compact:true})
        const remaining=expected.ids.length-seen.length,capture=captures.at(-1)
        assert.equal(page.records.length,Math.min(cap,remaining));assert.equal(page.exhausted,page.records.length===remaining)
        assert.equal(Number(capture.range.split('/')[1]),remaining)
        const query=new URLSearchParams(capture.query)
        assert.ok(query.get('select').includes('before_row:audit_browsing_before_row'))
        assert.equal(query.get('order'),'occurred_at.desc,id.desc')
        assert.equal(query.getAll('or').length,after===null?1:2)
        for(const record of page.records){const position={occurredAt:record.occurredAt,id:record.id};if(after)assert.ok(compareAuditBrowsePositions(position,after)<0);seen.push(record.id);after=position}
        if(page.exhausted){exhausted=true;break}
      }
      assert.equal(exhausted,true);assert.deepEqual(seen,expected.ids)
      compactProviderCaps.push({providerCap:cap,records:seen.length,batches:captures.length,exhaustionProved:true,actualComputedAliasAndOrdering:true})
    }finally{reader.finish();await capped.close()}
  }
  const browserRoleResults = []
  for (const role of ["anon","authenticated"]) {
    const denied = await startPostgrest(cluster,runtime,250,runtimeEnvironment,role)
    servers.push(denied)
    const response = await fetch(`${denied.origin}/audit_logs?select=id`)
    assert.equal(response.status,200); assert.deepEqual(await response.json(),[])
    const computed = await fetch(`${denied.origin}/audit_logs?select=id,before_row:audit_browsing_before_row`)
    const body = await computed.json()
    if(computed.status===200)assert.deepEqual(body,[])
    else{
      assert.ok([401,403].includes(computed.status),JSON.stringify({role,status:computed.status,body}))
      assert.equal(body.code,"42501",JSON.stringify({role,status:computed.status,body}))
    }
    browserRoleResults.push({role,rawRows:0,computedStatus:computed.status,sqlstate:body.code||null,executeDenied:true})
    await denied.close()
  }
  for (const name of ["audit_browsing_before_row","audit_browsing_after_row"]) for (const method of ["GET","POST"]) {
    const response = await fetch(`${server.origin}/rpc/${name}`,{method,...(method==="POST"?{headers:{"Content-Type":"application/json"},body:"{}"}:{})})
    assert.equal(response.status,404, "Unnamed composite computed field is not exposed as an ordinary RPC")
    await response.arrayBuffer()
  }
  await cluster.owner.query(`insert into public.audit_logs(id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
    select ('aaaaaaaa-aaaa-4aaa-8aaa-'||lpad((30000+n)::text,12,'0'))::uuid,'2026-10-25T01:00:00Z'::timestamptz+n*interval '1 microsecond',
      'synthetic@example.invalid','Synthetic User','app','public','email_templates','UPDATE',jsonb_build_object('id',n),array['body_html'],
      jsonb_build_object('id',n,'title','SYNTHETIC TEMPLATE '||n,'retained',repeat('r',2300),'body_html',repeat('h',18000),'body_text',repeat('t',4000)),
      jsonb_build_object('id',n,'title','SYNTHETIC TEMPLATE '||n,'retained',repeat('r',2300),'body_html',repeat('H',18000),'body_text',repeat('T',4000)),
      '{"pageId":"email-templates"}'::jsonb from generate_series(1,1000)n;`)
  const rawBytes = await cluster.owner.one(`select jsonb_build_object('bytes',octet_length(json_agg(t)::text)) from (select ${AUDIT_SELECT} from public.audit_logs where ${universe} order by occurred_at desc,id desc limit 250)t;`)
  assert.ok(rawBytes.bytes>11_000_000)
  const bulk = sdkFor(server,[])
  try { await assert.rejects(readAuditBrowsingBatch(bulk.client,null,250),error=>error.status===503) }
  finally { bulk.finish() }
  const scaleCaptures = [], scale = sdkFor(server,scaleCaptures), started = performance.now()
  let generation = startAuditBrowseGeneration(auditBrowseDigest("compact-native-scale")), scaleResult
  try {
    await Promise.all([loadAuditBrowsingPortNames(scale.client),loadAuditBrowsingUserNames(scale.client,"admin_users"),loadAuditBrowsingUserNames(scale.client,"spc_users")])
    scaleResult = await scanAuditBrowsePage({generation,pageSize:150,
      read:(position,limit)=>readAuditBrowsingBatch(scale.client,position,limit,{compact:true}),
      present:records=>presentAuditLogs(records,[],{portNames:new Map(),client:scale.client,includeDetails:false}),
      accept:record=>record.pageId==="event-calendar"})
  } finally { scale.finish() }
  const scaleElapsedMs = performance.now()-started
  assert.equal(scaleResult.state,"scan-pending"); assert.equal(scaleResult.records.length,0)
  assert.equal(generation.position,null); assert.equal(scaleResult.generation.position.id,id(30001))
  const scaleBatches=scaleCaptures.filter(item=>item.path==="/audit_logs")
  assert.equal(scaleBatches.length,4)
  for(const batch of scaleBatches){assert.ok(batch.bytes>=1_100_000&&batch.bytes<=1_600_000,JSON.stringify(batch));assert.equal(new URLSearchParams(batch.query).get("limit"),"250")}
  assert.ok(scaleCaptures.reduce((total,item)=>total+item.bytes,0)<8*1024*1024)
  const rawSingle = sdkFor(server,[])
  try {
    const page=await readAuditBrowsingBatch(rawSingle.client,null,1)
    assert.equal(page.records.length,1);assert.equal(page.exhausted,false)
    assert.equal(page.records[0].beforeRow.body_html.length,18000);assert.equal(page.records[0].afterRow.body_text.length,4000)
    const presented=await presentAuditLogs(page.records,[],{portNames:new Map(),client:rawSingle.client})
    assert.ok(presented[0].details.length>0)
  } finally {rawSingle.finish()}
  await cluster.owner.query(`insert into public.audit_logs(id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
    values('${id(50000)}','2026-10-26T01:00:00Z','synthetic@example.invalid','Synthetic User','app','public','email_templates','UPDATE','{}',array['body_html'],
      jsonb_build_object('title','LARGE SYNTHETIC','body_html',repeat('a',1000000),'body_text',repeat('b',100000)),
      jsonb_build_object('title','LARGE SYNTHETIC','body_html',repeat('c',1000000),'body_text',repeat('d',100000)),'{"pageId":"email-templates"}');`)
  const fullLarge=sdkFor(server,[])
  try{
    const fullPage=await scanAuditBrowsePage({generation:startAuditBrowseGeneration(auditBrowseDigest("bounded-full")),pageSize:150,batchSize:1,maxBatches:1,
      read:(position,limit)=>readAuditBrowsingBatch(fullLarge.client,position,limit),
      present:records=>presentAuditLogs(records,[],{portNames:new Map(),client:fullLarge.client}),accept:()=>true})
    assert.equal(fullPage.records.length,1);assert.equal(fullPage.state,"scan-pending")
    assert.equal(fullPage.records[0].beforeRow.body_html.length,1000000)
    assert.equal(fullPage.records[0].afterRow.body_text.length,100000)
  }finally{fullLarge.finish()}
  await cluster.owner.query(`insert into public.audit_logs(id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,before_row,after_row,request_context)
    values('${id(60000)}','2026-10-27T01:00:00Z','synthetic@example.invalid','Synthetic User','app','public','email_templates','UPDATE','{}',array['body_html'],
      jsonb_build_object('title','OVERSIZED SYNTHETIC','body_html',repeat('x',5*1024*1024)),jsonb_build_object('title','OVERSIZED SYNTHETIC','body_html',repeat('y',5*1024*1024)),'{"pageId":"email-templates"}');`)
  const oversized = sdkFor(server,[]), unchangedGeneration=startAuditBrowseGeneration(auditBrowseDigest("full-oversized"))
  try {
    await assert.rejects(scanAuditBrowsePage({generation:unchangedGeneration,pageSize:150,batchSize:1,maxBatches:1,
      read:(position,limit)=>readAuditBrowsingBatch(oversized.client,position,limit),present:async records=>records,accept:()=>true}),error=>error.status===503)
    assert.equal(unchangedGeneration.position,null)
  } finally {oversized.finish()}
  const compactGiant=sdkFor(server,[])
  try {assert.equal((await readAuditBrowsingBatch(compactGiant.client,null,1,{compact:true})).records[0].id,id(60000))}
  finally{compactGiant.finish()}
  evidence.compactProjection={cacheReloadObserved,acl:acl.rows,shapeCases:shapeProof.count,sqlAndJsonNullPreserved:true,typedIndexEquivalent:true,compactProviderCaps,browserRoles:browserRoleResults,ordinaryRpcUnavailable:true,
    rawFirst250Bytes:rawBytes.bytes,rawBulkRejected:true,indexBatchBytes:scaleBatches.map(item=>item.bytes),combinedConsumedBytes:scaleCaptures.reduce((sum,item)=>sum+item.bytes,0),elapsedMs:scaleElapsedMs,
    fourBatchState:scaleResult.state,fullModeRawLargeFieldsPreserved:true,fullModeRawBodyHtmlBytes:1000000,fullModeRawBodyTextBytes:100000,oversizedSingleFullRowRejectedWithoutProgress:true,compactOversizedTemplateStillReadable:true}
  await server.close()
}

test("owned PostgREST16.4 and PostgreSQL17.6 execute audit grammar/count/keyset/map contracts", { timeout: 120_000 }, async () => {
  const configured = process.env.NATIVE_POSTGREST_BIN
  assert.ok(configured && isAbsolute(configured), "NATIVE_POSTGREST_BIN must point to the explicit owned official16.4 runtime; no hosted or mocked fallback")
  const runtime = realpathSync(configured)
  assert.equal(sha(readFileSync(runtime)), releaseBinarySha, "Pinned official macOS arm64 runtime bytes")
  const archive = process.env.NATIVE_POSTGREST_ARCHIVE
  assert.ok(archive && isAbsolute(archive), "Use the verified owned release archive for independent provenance checking")
  assert.equal(sha(readFileSync(realpathSync(archive))), releaseArchiveSha)
  assert.ok(process.env.NATIVE_PG_BIN && isAbsolute(process.env.NATIVE_PG_BIN))
  const libraryDirectory = realpathSync(join(process.env.NATIVE_PG_BIN, "..", "lib"))
  const libpq = realpathSync(join(libraryDirectory, "libpq.5.dylib"))
  const runtimeEnvironment = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", TZ: "UTC", DYLD_LIBRARY_PATH: libraryDirectory }
  const version = (await execute(runtime, ["--version"], { env: runtimeEnvironment })).stdout.trim()
  assert.match(version, /^PostgREST 16\.4\b/)
  const linkedLibraries = (await execute("/usr/bin/otool", ["-L", runtime], { env: runtimeEnvironment })).stdout.trim()
  const libpqLibraries = (await execute("/usr/bin/otool", ["-L", libpq], { env: runtimeEnvironment })).stdout.trim()
  const cluster = await setupNativeCcinfo(fixtureSql)
  const evidence = { version, runtimeSha256: sha(readFileSync(runtime)), releaseArchiveSha256: releaseArchiveSha,
    libpqSha256: sha(readFileSync(libpq)), linkedLibraries, libpqLibraries, processScopedLibraryOverride: true,
    postgresVersion: cluster.version, postgresSha256: cluster.runtimeSha256, fixtureSha256: cluster.fixtureSha256,
    sources: Object.fromEntries(["lib/auditBrowsingSource.ts", "lib/auditBrowsingCursor.ts", "lib/auditBrowsingTransport.ts", "lib/auditBrowsing.ts", "lib/auditLog.ts", compactMigrationPath, "tests/audit-browsing-postgrest-native.test.mjs"].map(file => [file, sha(readFileSync(join(root, file)))])),
    cases: [], passed: false, cleanup: null, limits: ["Owned synthetic native servers, not the deployed Supabase PostgREST version or configuration.", "Exact count can scan the remaining population; no constant-time whole-query claim.", "A fetch deadline does not independently certify hosted database cancellation."] }
  const servers = []
  try {
    for (const cap of [17, 1]) {
      const server = await startPostgrest(cluster, runtime, cap, runtimeEnvironment)
      servers.push(server)
      const expected = await cluster.owner.one(`select jsonb_build_object('ids',(select jsonb_agg(id order by occurred_at desc,id desc) from public.audit_logs where ${universe}));`)
      const captures = [], reader = sdkFor(server, captures)
      let after = null
      const seen = [], batches = []
      try {
        for (let attempt = 0; attempt < 200; attempt++) {
          const page = await readAuditBrowsingBatch(reader.client, after, 250)
          const remaining = expected.ids.length - seen.length
          const capture = captures.at(-1)
          assert.match(capture.prefer, /count=exact/)
          assert.equal(Number(capture.range.split("/")[1]), remaining)
          assert.equal(page.records.length, Math.min(cap, remaining))
          assert.equal(page.exhausted, page.records.length === remaining)
          assert.equal(new URLSearchParams(capture.query).getAll("or").length, after === null ? 1 : 2)
          for (const record of page.records) {
            const position = { occurredAt: record.occurredAt, id: record.id }
            if (after) assert.ok(compareAuditBrowsePositions(position, after) < 0)
            assert.equal(seen.includes(record.id), false)
            seen.push(record.id); after = position
          }
          batches.push({ returned: page.records.length, remainingCount: remaining, exhausted: page.exhausted })
          if (page.exhausted) break
        }
        assert.deepEqual(seen, expected.ids)
        assert.deepEqual(seen.slice(0, 3), [id(1002), id(1001), id(1003)])
        assert.ok(!seen.some(value => [id(9001), id(9002), id(9003)].includes(value)))
        const empty = await readAuditBrowsingBatch(reader.client, after, 250)
        assert.equal(empty.records.length, 0); assert.equal(empty.exhausted, true)
        const offset = await readAuditBrowsingBatch(reader.client, { occurredAt: "2026-10-20T09:00:00.123456+08:00", id: id(1002) }, 250)
        assert.equal(offset.records[0].id, id(1001)); assert.match(offset.records[0].occurredAt, /\.123456/)
      } finally { reader.finish() }
      const mapsReader = sdkFor(server, captures)
      try {
        const [ports, admin, spc] = await Promise.all([loadAuditBrowsingPortNames(mapsReader.client), loadAuditBrowsingUserNames(mapsReader.client, "admin_users"), loadAuditBrowsingUserNames(mapsReader.client, "spc_users")])
        assert.equal(ports.size, 39); assert.equal(ports.get("39"), "SYNTHETIC PORT 39")
        assert.equal(admin.length, 35); assert.equal(admin.at(-1).displayName, "ADMIN USER 35")
        assert.equal(spc.length, 31); assert.equal(spc.at(-1).displayName, "SPC USER 31")
      } finally { mapsReader.finish() }
      // The actual scanner and canonical presenter continue repeated zero-match
      // pages rather than declaring a false absence before older matching rows.
      let generation = startAuditBrowseGeneration(auditBrowseDigest("owned-native-classification")), terminal = false
      const matching = [], scanStates = []
      for (let attempt = 0; attempt < 100; attempt++) {
        const scanReader = sdkFor(server, captures)
        let result
        try {
          result = await scanAuditBrowsePage({ generation, pageSize: 1,
            read: (position, limit) => readAuditBrowsingBatch(scanReader.client, position, limit),
            present: records => presentAuditLogs(records, [], { portNames: new Map(), client: scanReader.client }),
            accept: record => record.pageId === "event-calendar",
          })
        } finally { scanReader.finish() }
        matching.push(...result.records.map(record => record.id)); scanStates.push(result.state); generation = result.generation
        if (result.state === "exhausted") { terminal = true; break }
      }
      assert.equal(terminal, true)
      const expectedMatching = await cluster.owner.one(`select jsonb_build_object('ids',(select jsonb_agg(id order by occurred_at desc,id desc) from public.audit_logs where ${universe} and request_context->>'pageId'='event-calendar'));`)
      assert.deepEqual(matching, expectedMatching.ids)
      assert.ok(scanStates.includes("scan-pending"))
      if (cap === 17) {
        const observer = await cluster.session("snapshot-observer", false)
        const writer = await cluster.session("snapshot-writer", false)
        await cluster.owner.query("select pg_advisory_lock(81813);")
        const snapshotCaptures = [], snapshot = sdkFor(server, snapshotCaptures, { "x-synthetic-audit-gate": "1" })
        const reading = readAuditBrowsingBatch(snapshot.client, null, 250)
        void reading.catch(() => {})
        try {
          try {
            const deadline = Date.now() + 3000
            let blocked = false
            while (Date.now() < deadline) {
              const state = await observer.one("select jsonb_build_object('blocked',exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.application_name='fcuno_owned_audit_postgrest'));")
              if (state.blocked) { blocked = true; break }
              await new Promise(resolve => setTimeout(resolve, 20))
            }
            assert.equal(blocked, true, "Observe a real PostgREST SELECT waiting inside the owned RLS gate")
            await writer.query(`insert into public.audit_logs(id,occurred_at,actor_id,actor_name,actor_source,table_schema,table_name,operation,record_pk,changed_fields,after_row,request_context) values('${id(8000)}','2026-10-20T01:00:00.120000Z','synthetic@example.invalid','Snapshot Insert','app','public','office_calendar_store','UPDATE','{"key":"task-calendar"}','{}','{"key":"task-calendar"}','{"pageId":"task-calendar"}');`)
          } finally { await cluster.owner.query("select pg_advisory_unlock(81813);") }
          const page = await reading
          assert.equal(page.records.length, cap)
          assert.deepEqual(page.records.map(record => record.id), expected.ids.slice(0, cap), "The in-flight data excludes the concurrently committed row")
          assert.equal(Number(snapshotCaptures.at(-1).range.split("/")[1]), expected.ids.length, "Data and exact count share the pre-insert statement snapshot")
          evidence.cases.push({ providerCap: cap, statementSnapshot: { observedBlockedSelect: true, concurrentInsertCommitted: true, inFlightRowsUnchanged: true, inFlightCount: expected.ids.length, nextStatementCount: expected.ids.length + 1 } })
        } finally { snapshot.finish() }
        const freshCaptures = [], fresh = sdkFor(server, freshCaptures)
        try {
          const page = await readAuditBrowsingBatch(fresh.client, null, 250)
          assert.ok(page.records.some(record => record.id === id(8000)), "The next statement sees the new row within its first page")
          assert.equal(Number(freshCaptures.at(-1).range.split("/")[1]), expected.ids.length + 1)
        } finally { fresh.finish() }
      }
      evidence.cases.push({ providerCap: cap, rawRecords: seen.length, batches, maps: { ports: 39, adminUsers: 35, spcUsers: 31 },
        strictGrammarAndOrdering: true, offsetMicroseconds: true, hiddenUniverseExcluded: true, matchingRecords: matching.length, scanStates, httpRequests: captures.length })
      await server.close()
    }
    await verifyCompactProjection(cluster, runtime, runtimeEnvironment, servers, evidence)
    evidence.passed = true
  } finally {
    const stopped = await Promise.all(servers.map(server => server.close()))
    await cluster.close()
    evidence.cleanup = { ownedPostgrestChildrenClosed: stopped.length, ownedPostgresClosed: true, noDatabaseTcpListener: true, noExternalRequestsOrCredentials: true }
    const output = process.env.AUDIT_POSTGREST_EVIDENCE || join(cluster.root, "audit-postgrest-evidence")
    assert.ok(isAbsolute(output))
    mkdirSync(output, { recursive: true, mode: 0o700 })
    writeFileSync(join(output, "results.json"), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ evidence: join(output, "results.json"), caps: evidence.cases.filter(item => item.rawRecords).map(item => item.providerCap), cleanup: evidence.cleanup }))
  }
})
