// Runs the real PostgreSQL migration in an isolated WASM database, never production.
// SPC_QUEUE_TEST_PGLITE_MODULE=/tmp/fcuno-redelivery-sql-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/spc-group-dispatcher-queue.test.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')
const dispatcher = '00000000-0000-0000-0000-000000000001'
const oldToken = 'a'.repeat(64)
const newToken = 'b'.repeat(64)

test('delivery submission SQL fences retries, concurrent workers, and uncertain outcomes', async (t) => {
  const { PGlite } = await import(process.env.SPC_QUEUE_TEST_PGLITE_MODULE || '@electric-sql/pglite')
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.spc_group_dispatchers (id uuid primary key, active boolean not null default true);
    create table public.spc_group_delivery_jobs (
      id uuid primary key default gen_random_uuid(), status text default 'queued',
      destination_group_name text default 'TEST GROUP', attempt_count integer default 0,
      available_at timestamptz default clock_timestamp(), claimed_by uuid,
      claim_token_hash text, lease_expires_at timestamptz, last_error text, sent_at timestamptz,
      created_at timestamptz default clock_timestamp(), updated_at timestamptz default clock_timestamp()
    );
    insert into public.spc_group_dispatchers (id) values ('${dispatcher}');
    insert into public.spc_group_delivery_jobs (status, attempt_count) values ('claimed', 1), ('failed', 20);
  `)
  const migration = await fs.readFile(path.join(__dirname, '../supabase/migrations/20260915025433_fence_spc_group_delivery_submission.sql'), 'utf8')
  await db.exec(migration)
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows
  const reset = async () => {
    await db.exec('truncate public.spc_group_delivery_jobs; update public.spc_group_dispatchers set active=true;')
  }
  const enqueue = async (attempt = 0) => (await rows('insert into public.spc_group_delivery_jobs (attempt_count) values ($1) returning *', [attempt]))[0]
  const claim = (token = oldToken) => rows('select * from public.claim_spc_group_delivery_job_v2($1,$2,90)', [dispatcher, token])
  const prepare = (id, token = oldToken) => rows('select * from public.prepare_spc_group_delivery_job($1,$2,$3)', [id, dispatcher, token])
  const complete = (id, result, token = oldToken) => rows('select * from public.complete_spc_group_delivery_job($1,$2,$3,$4,$5)', [id, dispatcher, token, result, 'Exact group not found'])
  const expire = id => db.query("update public.spc_group_delivery_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [id])

  await t.test('migration stops legacy in-flight and exhausted jobs, and disables legacy claims', async () => {
    assert.deepEqual((await rows('select status from public.spc_group_delivery_jobs')).map(row => row.status), ['manual_review', 'manual_review'])
    await enqueue()
    assert.equal((await rows('select * from public.claim_spc_group_delivery_job($1,$2,90)', [dispatcher, oldToken])).length, 0)
  })
  await t.test('inactive dispatchers cannot claim and multiple tabs cannot claim different jobs', async () => {
    await reset(); await enqueue(); await enqueue()
    await db.exec('update public.spc_group_dispatchers set active=false')
    assert.equal((await claim()).length, 0)
    await db.exec('update public.spc_group_dispatchers set active=true')
    assert.equal((await claim()).length, 1)
    assert.equal((await claim(newToken)).length, 0)
  })
  await t.test('expired unprepared claim can be reclaimed; original token cannot prepare or complete', async () => {
    await reset(); await enqueue()
    const [job] = await claim()
    await expire(job.id)
    assert.equal((await prepare(job.id)).length, 0)
    const [next] = await claim(newToken)
    assert.equal(next.id, job.id); assert.equal(next.attempt_count, 2)
    assert.equal((await prepare(job.id)).length, 0)
    assert.equal((await complete(job.id, 'sent')).length, 0)
    assert.equal((await prepare(job.id, newToken)).length, 1)
  })
  await t.test('preparation is one-shot and an expired prepared job is never automatically reclaimed', async () => {
    await reset(); await enqueue()
    const [job] = await claim()
    assert.equal((await prepare(job.id, newToken)).length, 0)
    assert.equal((await prepare(job.id)).length, 1)
    assert.equal((await prepare(job.id)).length, 0)
    await expire(job.id)
    assert.equal((await claim(newToken)).length, 0)
    assert.equal((await rows('select status from public.spc_group_delivery_jobs where id=$1', [job.id]))[0].status, 'manual_review')
  })
  await t.test('a failure after preparing becomes manual review; successful prepared send completes', async () => {
    await reset(); await enqueue()
    const [job] = await claim(); await prepare(job.id)
    assert.equal((await complete(job.id, 'failed'))[0].status, 'manual_review')
    await enqueue()
    const [second] = await claim(); await prepare(second.id)
    const [sent] = await complete(second.id, 'sent')
    assert.equal(sent.status, 'sent'); assert.ok(sent.sent_at)
  })
  await t.test('completion cannot invent an unprepared send or bypass an expired preparation', async () => {
    await reset(); await enqueue()
    const [job] = await claim()
    assert.equal((await complete(job.id, 'sent'))[0].status, 'manual_review')
    await enqueue()
    const [second] = await claim(); await prepare(second.id); await expire(second.id)
    assert.equal((await complete(second.id, 'sent'))[0].status, 'manual_review')
  })
  await t.test('20th failed attempt stops with an explicit review status; earlier backoff remains 15 seconds per attempt', async () => {
    for (const priorAttempts of [0, 1, 18, 19]) {
      await reset(); await enqueue(priorAttempts)
      const [job] = await claim()
      const [result] = await complete(job.id, 'failed')
      if (priorAttempts === 19) {
        assert.equal(result.status, 'manual_review'); assert.match(result.last_error, /20 attempts/)
      } else {
        assert.equal(result.status, 'failed')
        const seconds = (Date.parse(result.available_at) - Date.parse(result.updated_at)) / 1000
        assert.ok(Math.abs(seconds - 15 * (priorAttempts + 1)) < 0.1)
      }
      assert.equal((await claim(newToken)).length, 0)
    }
  })
  await t.test('20th expired unprepared claim is terminal and revocation rejects preparation/completion', async () => {
    await reset(); await enqueue(19)
    const [job] = await claim(); await expire(job.id)
    assert.equal((await claim(newToken)).length, 0)
    assert.equal((await rows('select status from public.spc_group_delivery_jobs where id=$1', [job.id]))[0].status, 'manual_review')
    await enqueue()
    const [second] = await claim()
    await db.exec('update public.spc_group_dispatchers set active=false')
    assert.equal((await prepare(second.id)).length, 0)
    assert.equal((await complete(second.id, 'failed')).length, 0)
  })
  await t.test('idle claim polling does not issue job UPDATE statements and RPCs remain service-only', async () => {
    await reset()
    await db.exec(`
      create table update_calls (id integer);
      create function track_job_update() returns trigger language plpgsql as $$ begin insert into update_calls values (1); return null; end; $$;
      create trigger count_update_statements after update on public.spc_group_delivery_jobs for each statement execute function track_job_update();
    `)
    assert.equal((await claim()).length, 0)
    assert.equal((await rows('select * from update_calls')).length, 0)
    for (const signature of ['claim_spc_group_delivery_job_v2(uuid,text,integer)', 'prepare_spc_group_delivery_job(uuid,uuid,text)', 'complete_spc_group_delivery_job(uuid,uuid,text,text,text)']) {
      const [permission] = await rows("select has_function_privilege('anon',$1,'execute') as anon, has_function_privilege('authenticated',$1,'execute') as authenticated, has_function_privilege('service_role',$1,'execute') as service", [signature])
      assert.deepEqual(permission, {anon:false, authenticated:false, service:true})
    }
  })
})
