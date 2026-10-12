import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { createHash, randomUUID } from "node:crypto"

const execute = promisify(execFile)
export const basis = "11111111-1111-4111-8111-111111111111"
export const linked = "22222222-2222-4222-8222-222222222222"
export const other = "33333333-3333-4333-8333-333333333333"
export const literal = value => `'${String(value).replaceAll("'", "''")}'`
export const json = value => `${literal(JSON.stringify(value))}::jsonb`
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
const hash = value => createHash("sha256").update(value).digest("hex")

function bounded(text, from, to) {
  const start = text.indexOf(from), end = text.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `Production SQL boundaries changed: ${from}`)
  return text.slice(start, end)
}

// A real psql process per session, not multiple clients queued onto one backend.
// Its connection arguments are owned Unix-socket paths; inherited PG* variables,
// password files, personal psql startup files and all network hosts are ignored.
class Session {
  constructor(cluster, label, database) {
    this.cluster = cluster
    this.label = label
    this.stderr = ""
    this.buffer = ""
    this.closed = false
    this.process = spawn(join(cluster.bin, "psql"), [
      "-X", "-q", "-A", "-t", "--no-readline", "--no-password",
      "--set", "ON_ERROR_STOP=1", "--host", cluster.socket,
      "--port", "55487", "--username", "fcuno_fixture_owner", "--dbname", database,
    ], { env: cluster.environment, stdio: ["pipe", "pipe", "pipe"] })
    this.process.stdout.setEncoding("utf8")
    this.process.stderr.setEncoding("utf8")
    this.process.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-1048576) })
    this.process.stdout.on("data", chunk => {
      this.buffer += chunk
      let newline
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "")
        this.buffer = this.buffer.slice(newline + 1)
        if (!this.pending) continue
        if (line === this.pending.marker) {
          const pending = this.pending
          this.pending = null
          clearTimeout(pending.timer)
          pending.resolve(pending.lines)
        } else if (line.length) this.pending.lines.push(line)
      }
    })
    this.done = new Promise(resolve => this.process.once("close", (code, signal) => {
      this.closed = true
      if (this.pending) {
        const pending = this.pending
        this.pending = null
        clearTimeout(pending.timer)
        const error = new Error(`${label}: psql exited ${code ?? signal}: ${this.stderr}`)
        error.code = this.stderr.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]
        pending.reject(error)
      }
      resolve({ code, signal })
    }))
    this.process.on("error", error => {
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null }
    })
    this.process.stdin.on("error", error => {
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null }
    })
  }

  query(sql) {
    assert.equal(this.closed, false, `${this.label} is closed`)
    assert.equal(this.pending == null, true, `${this.label} already has a query in flight`)
    return new Promise((resolve, reject) => {
      const marker = `FCUNO_NATIVE_DONE_${randomUUID()}`
      const timer = setTimeout(() => {
        this.process.kill("SIGTERM")
        reject(new Error(`${this.label}: native query exceeded the 20-second fixture limit`))
      }, 20000)
      this.pending = { marker, timer, resolve, reject, lines: [] }
      this.process.stdin.write(`\\set VERBOSITY verbose\n${sql}\n\\echo ${marker}\n`)
    })
  }

  async one(sql) {
    const rows = await this.query(sql)
    assert.equal(rows.length, 1, `${this.label}: expected one JSON result, got ${JSON.stringify(rows)}`)
    return JSON.parse(rows[0])
  }

  async begin(actor = this.label, correlation = randomUUID()) {
    const headers = {
      "x-bunker-admin-user": actor,
      "x-bunker-admin-display-name": actor,
      "x-bunker-admin-page-id": "pricesetter",
      "x-bunker-admin-page-path": "/admin/pricesetter",
      "x-bunker-audit-correlation-id": correlation,
      "x-bunker-audit-request-id": correlation,
      "x-bunker-audit-action": "native-isolated-verification",
    }
    await this.query(`begin; set local role service_role;
      do $$ begin perform set_config('request.headers', ${literal(JSON.stringify(headers))}, true); end $$;`)
    return correlation
  }

  async close() {
    if (this.closed) return this.done
    this.process.stdin.end("\\q\n")
    const timer = setTimeout(() => this.process.kill("SIGTERM"), 3000)
    try { return await this.done } finally { clearTimeout(timer) }
  }
}

export async function setupNativePricing() {
  const configured = process.env.NATIVE_PG_BIN
  assert.ok(configured && isAbsolute(configured), "NATIVE_PG_BIN must identify a private native PostgreSQL 17.6 bin directory; PGlite/remote fallbacks and skipped verification are forbidden")
  const bin = realpathSync(configured)
  const environment = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", PGAPPNAME: "fcuno-owned-native-pricing-verification" }
  const version = (await execute(join(bin, "postgres"), ["--version"], { env: environment })).stdout.trim()
  assert.equal(version, "postgres (PostgreSQL) 17.6", "Use the pinned production-major/minor comparison runtime")
  const root = mkdtempSync("/private/tmp/fcuno-native-pricing-")
  // libpq can consult a password file even with --no-password. Pin it to an
  // intentionally nonexistent owned path instead of the user's default file.
  environment.PGPASSFILE = join(root, "no-personal-password-file")
  const data = join(root, "data"), socket = join(root, "socket")
  mkdirSync(socket, { mode: 0o700 })
  const cluster = { bin, root, data, socket, environment, sessions: [], started: false, version,
    runtimeSha256: hash(readFileSync(join(bin, "postgres"))) }
  async function close() {
    await Promise.all(cluster.sessions.map(session => session.close()))
    if (cluster.started) {
      await execute(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env: environment })
      cluster.started = false
    }
  }
  async function session(label, service = true, database = "postgres") {
    assert.ok(["postgres", "native_pricing_recovery"].includes(database), "Only owned fixture database names are allowed")
    const client = new Session(cluster, label, database)
    cluster.sessions.push(client)
    const native = await client.one("select jsonb_build_object('pid',pg_backend_pid(),'server',current_setting('server_version_num'),'listen',current_setting('listen_addresses'),'socket',current_setting('unix_socket_directories')); ")
    assert.equal(native.server, "170006")
    assert.equal(native.listen, "")
    assert.equal(native.socket, socket)
    await client.query("set timezone='UTC';")
    if (service) await client.query("set role service_role;")
    const identity = await client.one("select jsonb_build_object('pid',pg_backend_pid(),'role',current_user,'sessionRole',session_user); ")
    assert.equal(identity.role, service ? "service_role" : "fcuno_fixture_owner")
    assert.equal(identity.pid, native.pid)
    client.pid = identity.pid
    return client
  }
  try {
    await execute(join(bin, "initdb"), ["-D", data, "--username=fcuno_fixture_owner", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"], { env: environment, maxBuffer: 1048576 })
    await execute(join(bin, "pg_ctl"), ["-D", data, "-l", join(root, "server.log"), "-w", "-o", `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55487 -c max_connections=16 -c shared_buffers=32MB -c log_lock_waits=on -c deadlock_timeout=200ms`, "start"], { env: environment })
    cluster.started = true
    const owner = await session("fixture-owner", false)
    await owner.query(`
      create role anon; create role authenticated; create role service_role noinherit bypassrls;
      grant usage on schema public to service_role;
      create table public.ports(id uuid primary key default gen_random_uuid(),name text not null,lat numeric,lng numeric,hsfo numeric,vlsfo numeric,mgo numeric,hsfo_formula text,vlsfo_formula text,mgo_formula text,updated_at date,display_order integer,type text default 'port',region text);
      create table public.price_history(id uuid primary key default gen_random_uuid(),port_id uuid references public.ports(id) on delete cascade,hsfo numeric,vlsfo numeric,mgo numeric,recorded_at timestamp without time zone default now());
      create table public.remarks(id integer primary key,content text);
      alter table public.ports enable row level security; alter table public.price_history enable row level security; alter table public.remarks enable row level security;
      grant select,insert,update,delete on public.ports,public.price_history,public.remarks to service_role;
      insert into ports(id,name,hsfo,vlsfo,mgo,updated_at,display_order) values
        ('${basis}','Basis',600,800,1000,'2026-10-08',1),('${linked}','Linked',null,null,null,'2026-10-08',2),('${other}','Other',100,200,300,'2026-10-08',3);
      update ports set vlsfo_formula='Basis + 0',mgo_formula='Basis + 5' where id='${linked}';
      insert into remarks values(1,'First notice'),(2,'Second notice');
    `)
    const audited = bounded(source("supabase/audit_log.sql"), "create table if not exists public.audit_logs (", "create or replace function public.audit_pk_where(")
    const enableAuditSource = source("supabase/audit_log.sql")
    const enableStart = enableAuditSource.indexOf("create or replace function public.audit_enable_table(p_table regclass)")
    assert.ok(enableStart >= 0, "Missing production audit trigger attachment helper")
    const enableEnd = enableAuditSource.indexOf("$$;", enableStart) + 3
    const enableAudit = enableAuditSource.slice(enableStart, enableEnd)
    // Core PostgreSQL 17 provides gen_random_uuid(); the unrelated pgcrypto
    // extension bootstrap and unrelated full-site undo/Outlook functions are
    // not needed. Every executed pricing/audit/epoch function body is exact.
    const epoch = source("supabase/migrations/20260723101257_add_backup_export_epoch.sql").split("\ndo $$")[0]
    await owner.query(`${audited}\n${enableAudit}\n${epoch}`)
    // Existing live hardening pins these pure helpers too; keep the native
    // fixture's function settings identical, not only their source bodies.
    await owner.query(`alter function public.audit_json_setting(text) set search_path=public,pg_temp;
      alter function public.audit_request_header(text) set search_path=public,pg_temp;
      alter function public.audit_text_setting(text) set search_path=public,pg_temp;`)
    const migrations = [
      "20261008112629_atomic_price_setter_save.sql",
      "20261009025254_atomic_market_history_changes.sql",
      "20261009032431_coherent_report_publication.sql",
      "20261009043924_recover_damaged_report_publications.sql",
      "20261009044514_protect_price_setter_port_deletion.sql",
      "20261009045645_protect_required_report_port_identity.sql",
      "20261009050520_idempotent_price_setter_port_creation.sql",
      "20261009051842_complete_price_setter_inventory.sql",
      "20261009054830_durable_price_setter_creation_recovery.sql",
      "20261009070459_fence_legacy_price_setter_creation.sql",
      "20261009110700_order_divider_rename_locks.sql",
      "20261012112711_normalize_market_history_root_lookup.sql",
    ]
    const sourceHashes = { auditDeclarations: hash(audited), auditAttachmentHelper: hash(enableAudit), backupEpochFunctions: hash(epoch) }
    for (const file of migrations) {
      const sql = source(`supabase/migrations/${file}`)
      sourceHashes[file] = hash(sql)
      await owner.query(sql)
    }
    for (const table of ["ports", "price_history", "remarks"]) await owner.query(`select public.audit_enable_table('public.${table}'::regclass);`)
    // These exact existing per-statement triggers are intentionally attached
    // only to the isolated pricing/audit tables, not invented full-site tables.
    for (const table of ["ports", "price_history", "remarks", "audit_logs"]) await owner.query(`create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${table} for each statement execute function private.record_bunker_map_backup_mutation();`)
    async function state(reader = owner) {
      return reader.one(`select jsonb_build_object(
        'ports',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from ports t),
        'history',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from price_history t),
        'remarks',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from remarks t),
        'receipts',(select coalesce(jsonb_agg(to_jsonb(t) order by request_id),'[]') from price_setter_creation_receipts t),
        'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from audit_logs t),
        'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
    }
    async function dumpAndRestore() {
      const file = join(root, "pricing-recovery.dump")
      const connection = ["--host", socket, "--port", "55487", "--username", "fcuno_fixture_owner", "--no-password"]
      await execute(join(bin, "pg_dump"), [...connection, "--format=custom", "--file", file, "--dbname", "postgres"], { env: environment, maxBuffer: 1048576 })
      await execute(join(bin, "createdb"), [...connection, "--template=template0", "native_pricing_recovery"], { env: environment })
      await execute(join(bin, "pg_restore"), [...connection, "--exit-on-error", "--single-transaction", "--dbname", "native_pricing_recovery", file], { env: environment, maxBuffer: 1048576 })
      return { file, sha256: hash(readFileSync(file)), owner: await session("recovery-owner", false, "native_pricing_recovery"),
        service: await session("recovery-service", true, "native_pricing_recovery") }
    }
    return { ...cluster, owner, session, close, state, sourceHashes, dumpAndRestore }
  } catch (error) { await close(); throw error }
}

export async function waitForBlock(observer, waiter, blocker, locktype) {
  const deadline = Date.now() + 3000
  let observed
  do {
    observed = await observer.one(`select jsonb_build_object('waiter',${waiter.pid},'blockers',pg_blocking_pids(${waiter.pid}),'waiting',(select coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode,'relation',relation::regclass::text)),'[]') from pg_locks where pid=${waiter.pid} and not granted));`)
    if (observed.blockers.includes(blocker.pid) && (!locktype || observed.waiting.some(lock => lock.type === locktype))) return observed
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  assert.fail(`Native backend ${waiter.pid} did not block on ${blocker.pid}: ${JSON.stringify(observed)}`)
}
