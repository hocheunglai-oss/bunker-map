// Execute the existing production RPCs in an isolated PostgreSQL WASM database.
// SPC_QUEUE_TEST_PGLITE_MODULE=/tmp/fcuno-redelivery-sql-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/spc-user-delivery-route-sql.test.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')

const adminId = '00000000-0000-0000-0000-000000000001'
const activeRoute = '00000000-0000-0000-0000-000000000002'
const inactiveRoute = '00000000-0000-0000-0000-000000000003'
const unknownRoute = '00000000-0000-0000-0000-000000000004'
const password = `scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}`

function functionSource(sql, name) {
  const start = sql.indexOf(`create or replace function ${name}(`)
  assert.ok(start >= 0, `${name} must be present`)
  return sql.slice(start, sql.indexOf('\n$$;', start) + 4)
}

test('SPC user RPC allows empty enquiry routes while preserving supplied-route validation', async (t) => {
  const { PGlite } = await import(process.env.SPC_QUEUE_TEST_PGLITE_MODULE || '@electric-sql/pglite')
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.spc_delivery_routes (id uuid primary key, is_active boolean not null);
    create table public.spc_users (
      id uuid primary key default gen_random_uuid(), username text not null, display_name text,
      whatsapp_phone text, role text not null, password_hash text not null,
      is_active boolean not null default true,
      delivery_route_id uuid references public.spc_delivery_routes(id) on delete restrict,
      created_at timestamptz default clock_timestamp(), updated_at timestamptz default clock_timestamp()
    );
    create table public.office_calendar_store (key text primary key, payload jsonb, updated_at timestamptz);
    insert into public.spc_users(id,username,role,password_hash) values ('${adminId}','admin@example.test','buyer_trader','${password}');
    insert into public.office_calendar_store values ('spc-permission-groups',
      '{"userRoles":[{"userId":"${adminId}","username":"admin@example.test","role":"ADMIN"}]}',clock_timestamp());
    insert into public.spc_delivery_routes values ('${activeRoute}',true),('${inactiveRoute}',false);
  `)
  const continuity = await fs.readFile(path.join(__dirname, '../supabase/migrations/20260806203000_enforce_spc_admin_continuity.sql'), 'utf8')
  await db.exec(continuity)
  const routing = await fs.readFile(path.join(__dirname, '../supabase/migrations/20260819025850_add_spc_delivery_routes.sql'), 'utf8')
  const bootstrap = await fs.readFile(path.join(__dirname, '../supabase/spc_schema.sql'), 'utf8')
  const saveFunction = functionSource(routing, 'public.save_spc_user_with_delivery_route')
  assert.equal(functionSource(bootstrap, 'public.save_spc_user_with_delivery_route'), saveFunction)
  await db.exec(saveFunction)
  const grantStart = routing.indexOf('revoke all on function public.save_spc_user_with_delivery_route(')
  const grantEnd = routing.indexOf(') to service_role;', grantStart) + ') to service_role;'.length
  await db.exec(routing.slice(grantStart, grantEnd))
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows
  const save = (username, role, route, id = null, active = true) => rows(
    'select * from public.save_spc_user_with_delivery_route($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [id, username, 'TEST ROUTE OPTIONAL', null, 'buyer_trader', role, 'HONG KONG', true, false, id ? null : password, active, route],
  )
  let buyer
  let additionalAdmin

  await t.test('active buyer and admin can be created without a route', async () => {
    ;[buyer] = await save('buyer@example.test', 'BUYER TRADER', null)
    ;[additionalAdmin] = await save('second-admin@example.test', 'ADMIN', null)
    for (const user of [buyer, additionalAdmin]) {
      assert.equal(user.delivery_route_id, null)
      assert.equal(user.is_active, true)
    }
    const [profile] = await rows("select private.spc_effective_role($1,$2,$3,payload) as role from office_calendar_store where key='spc-permission-groups'", [additionalAdmin.id, additionalAdmin.username, additionalAdmin.role])
    assert.equal(profile.role, 'ADMIN')
  })
  await t.test('an assigned active route can be cleared without changing account state or role', async () => {
    const [assigned] = await save(buyer.username, 'BUYER TRADER', activeRoute, buyer.id)
    assert.equal(assigned.delivery_route_id, activeRoute)
    const [cleared] = await save(buyer.username, 'BUYER TRADER', null, buyer.id)
    assert.equal(cleared.delivery_route_id, null)
    assert.equal(cleared.id, buyer.id)
    assert.equal(cleared.is_active, true)
    assert.equal(cleared.role, buyer.role)
  })
  await t.test('unknown and inactive selected routes are rejected before creating or changing users', async () => {
    for (const route of [inactiveRoute, unknownRoute]) {
      await assert.rejects(save('invalid-route@example.test', 'BUYER TRADER', route), /Select an active enquiry delivery route/)
      await assert.rejects(save(buyer.username, 'BUYER TRADER', route, buyer.id), /Select an active enquiry delivery route/)
    }
    assert.equal((await rows("select id from public.spc_users where username='invalid-route@example.test'")).length, 0)
    assert.equal((await rows('select delivery_route_id from public.spc_users where id=$1', [buyer.id]))[0].delivery_route_id, null)
  })
  await t.test('empty route does not bypass final-admin continuity or browser-role RPC restrictions', async () => {
    await save(additionalAdmin.username, 'ADMIN', null, additionalAdmin.id, false)
    await assert.rejects(save('admin@example.test', 'BUYER TRADER', null, adminId), /final active ADMIN cannot be demoted/)
    const [permission] = await rows("select has_function_privilege('anon',$1,'execute') as anon, has_function_privilege('authenticated',$1,'execute') as authenticated, has_function_privilege('service_role',$1,'execute') as service", ['public.save_spc_user_with_delivery_route(uuid,text,text,text,text,text,text,boolean,boolean,text,boolean,uuid)'])
    assert.deepEqual(permission, {anon:false, authenticated:false, service:true})
  })
})
