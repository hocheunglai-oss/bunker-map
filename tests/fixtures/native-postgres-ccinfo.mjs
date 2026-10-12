import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"

const execute = promisify(execFile)
export const literal = value => `'${String(value).replaceAll("'", "''")}'`

// Each Session owns a separate native psql backend. No remote hosts, personal
// password/startup files, inherited PG* variables or pricing fixture are used.
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
      "--port", "55489", "--username", "fcuno_ccinfo_fixture_owner", "--dbname", database,
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
    const failed = error => {
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null }
    }
    this.process.on("error", failed)
    this.process.stdin.on("error", failed)
  }

  query(sql) {
    assert.equal(this.closed, false, `${this.label} is closed`)
    assert.equal(this.pending == null, true, `${this.label} already has a query in flight`)
    return new Promise((resolve, reject) => {
      const marker = `FCUNO_CCINFO_DONE_${randomUUID()}`
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

  async begin(actor = this.label) {
    const headers = {
      "x-bunker-admin-user": actor,
      "x-bunker-admin-page-id": "ccinfo",
      "x-bunker-audit-correlation-id": randomUUID(),
      "x-bunker-audit-action": "native-isolated-verification",
    }
    await this.query(`begin; set local role service_role;
      do $$ begin perform set_config('request.headers', ${literal(JSON.stringify(headers))}, true); end $$;`)
  }

  async close() {
    if (this.closed) return this.done
    this.process.stdin.end("\\q\n")
    const timer = setTimeout(() => this.process.kill("SIGTERM"), 3000)
    try { return await this.done } finally { clearTimeout(timer) }
  }
}

export async function setupNativeCcinfo(sql) {
  assert.equal(typeof sql, "string")
  const configured = process.env.NATIVE_PG_BIN
  assert.ok(configured && isAbsolute(configured), "NATIVE_PG_BIN must identify an owned native PostgreSQL 17.6 bin directory; no hosted/PGlite fallback or skipped verification")
  const bin = realpathSync(configured)
  const environment = { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", PGAPPNAME: "fcuno-owned-native-ccinfo-verification" }
  const version = (await execute(join(bin, "postgres"), ["--version"], { env: environment })).stdout.trim()
  assert.equal(version, "postgres (PostgreSQL) 17.6")
  const root = mkdtempSync("/private/tmp/fcuno-native-ccinfo-")
  environment.PGPASSFILE = join(root, "no-personal-password-file")
  const data = join(root, "data"), socket = join(root, "socket")
  mkdirSync(socket, { mode: 0o700 })
  const cluster = { bin, root, data, socket, environment, sessions: [], started: false, version,
    runtimeSha256: createHash("sha256").update(readFileSync(join(bin, "postgres"))).digest("hex"),
    fixtureSha256: createHash("sha256").update(sql).digest("hex") }
  async function close() {
    await Promise.all(cluster.sessions.map(session => session.close()))
    if (cluster.started) {
      await execute(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { env: environment })
      cluster.started = false
    }
  }
  async function session(label, service = true, database = "postgres") {
    assert.ok(["postgres", "native_ccinfo_recovery"].includes(database), "Only owned fixture database names are allowed")
    const client = new Session(cluster, label, database)
    cluster.sessions.push(client)
    const native = await client.one("select jsonb_build_object('pid',pg_backend_pid(),'server',current_setting('server_version_num'),'listen',current_setting('listen_addresses'),'socket',current_setting('unix_socket_directories'));")
    assert.equal(native.server, "170006")
    assert.equal(native.listen, "")
    assert.equal(native.socket, socket)
    await client.query("set time zone 'UTC';")
    if (service) await client.query("set role service_role;")
    const identity = await client.one("select jsonb_build_object('pid',pg_backend_pid(),'role',current_user,'sessionRole',session_user);")
    assert.equal(identity.role, service ? "service_role" : "fcuno_ccinfo_fixture_owner")
    assert.equal(identity.pid, native.pid)
    client.pid = native.pid
    return client
  }
  try {
    await execute(join(bin, "initdb"), ["-D", data, "--username=fcuno_ccinfo_fixture_owner", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"], { env: environment, maxBuffer: 1048576 })
    await execute(join(bin, "pg_ctl"), ["-D", data, "-l", join(root, "server.log"), "-w", "-o", `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p 55489 -c max_connections=16 -c shared_buffers=32MB -c log_lock_waits=on -c deadlock_timeout=200ms`, "start"], { env: environment })
    cluster.started = true
    const owner = await session("fixture-owner", false)
    await owner.query(sql)
    await owner.query("reset role;")
    const state = (reader = owner) => reader.one(`select jsonb_build_object(
      'countries',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.cc_countries t),
      'ports',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.cc_ports t),
      'files',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.cc_entry_files t),
      'folders',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.cc_entry_folders t),
      'audit',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.audit_logs t),
      'epochs',(select coalesce(jsonb_agg(to_jsonb(t) order by mutation_id),'[]') from private.bunker_map_backup_mutations t));`)
    async function dumpAndRestore() {
      const file = join(root, "ccinfo-recovery.sql")
      const connection = ["--host", socket, "--port", "55489", "--username", "fcuno_ccinfo_fixture_owner", "--no-password"]
      await execute(join(bin, "pg_dump"), [...connection, "--format=plain", "--file", file, "--dbname", "postgres"], { env: environment, maxBuffer: 1048576 })
      await execute(join(bin, "createdb"), [...connection, "--template=template0", "native_ccinfo_recovery"], { env: environment })
      await execute(join(bin, "psql"), ["-X", ...connection, "--set", "ON_ERROR_STOP=1", "--single-transaction", "--dbname", "native_ccinfo_recovery", "--file", file], { env: environment, maxBuffer: 1048576 })
      return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        owner: await session("recovery-owner", false, "native_ccinfo_recovery"),
        service: await session("recovery-service", true, "native_ccinfo_recovery") }
    }
    return { ...cluster, owner, session, state, close, dumpAndRestore }
  } catch (error) { await close(); throw error }
}

export async function waitForBlock(observer, waiter, blocker, locktype, relation) {
  const deadline = Date.now() + 3000
  let observed
  do {
    observed = await observer.one(`select jsonb_build_object('waiter',${waiter.pid},'blockers',pg_blocking_pids(${waiter.pid}),'waiting',(select coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode,'relation',relation::regclass::text)),'[]') from pg_locks where pid=${waiter.pid} and not granted));`)
    if (observed.blockers.includes(blocker.pid) && (!locktype || observed.waiting.some(lock => lock.type === locktype && (!relation || lock.relation === relation)))) return observed
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  assert.fail(`Native backend ${waiter.pid} did not block on ${blocker.pid}: ${JSON.stringify(observed)}`)
}
