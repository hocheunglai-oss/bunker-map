import {randomUUID,literal,json}from"./outlook-hourly-verification-native.mjs"
import {resolution}from"./outlook-insertion-native.mjs"

// Public, synthetic workload dimensions taken from the dated aggregate-only
// diagnostic. External values and payload contents are fabricated test data.
// No application export, production credentials, or cloud connection is used.
export async function seedRealisticActivationVolume(f){
  await f.owner.query(`alter table public.shared_addressbook_contacts disable trigger user;alter table public.shared_addressbook_groups disable trigger user;alter table public.shared_addressbook_group_members disable trigger user;
    insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email)
    select 'c'||lpad(i::text,43,'0'),'SYNTHETIC','card'||i,'Synthetic Contact '||lpad(i::text,27,'0'),'c'||lpad(i::text,25,'0')||'@example.invalid'from generate_series(1,3461)i;
    insert into public.shared_addressbook_groups(id,source_book,source_uid,name,member_count)
    select 'g'||lpad(i::text,41,'0'),'SYNTHETIC','group'||i,'Synthetic Group '||lpad(i::text,20,'0'),3+case when i<=78 then 1 else 0 end from generate_series(1,359)i;
    insert into public.shared_addressbook_group_members(group_id,contact_id,source_book)
    select 'g'||lpad((1+(i-1)%359)::text,41,'0'),'c'||lpad(i::text,43,'0'),'SYNTHETIC'from generate_series(1,1155)i;
    alter table public.shared_addressbook_contacts enable trigger user;alter table public.shared_addressbook_groups enable trigger user;alter table public.shared_addressbook_group_members enable trigger user;`)
  const baseline=await f.commitProof(await f.packet(randomUUID(),"full"),{hourly:false});await f.setCurrentTruth(baseline)
  const refs=Array.from({length:485},()=>({to:[],cc:[],bcc:[]}))
  const ref=(field,i,position)=>{const group=i%2===0,id=(group?"g":"c")+String(1+i%(group?359:3461)).padStart(group?41:43,"0"),name=(group?"Synthetic Group ":"Synthetic Contact ")+String(1+i%(group?359:3461)).padStart(group?20:27,"0"),email=group?id+"@cosulich1.onmicrosoft.com":"c"+String(1+i%3461).padStart(25,"0")+"@example.invalid";return{field,position,literal:name+" <"+email+">",displayName:name,sourceValue:email,kind:group?"group":"contact",sourceId:id,status:"resolved",resolvedAddress:email}}
  for(const[field,count]of[["to",469],["cc",305],["bcc",733]])for(let i=0;i<count;i++){const index=i%485;refs[index][field].push(ref(field,i,refs[index][field].length))}
  for(const field of["to","cc","bcc"])while(Object.values(refs[0]).flat().length<28){const donor=refs.findIndex((r,i)=>i>20&&r[field].length);if(donor<0)break;refs[0][field].push(refs[donor][field].pop());if(Object.values(refs[0]).flat().length===28)break}
  const bodySize=(i,total,max)=>i===0?max:Math.floor((total-max)/484)+(i<=((total-max)%484)?1:0)
  for(let start=0;start<485;start+=50){const rows=[];for(let i=start;i<Math.min(start+50,485);i++){
    for(const[field,items]of Object.entries(refs[i]))items.forEach((r,p)=>{r.field=field;r.position=p})
    const all=Object.values(refs[i]).flat(),proof={...resolution(f.verified),refs:refs[i],counts:{total:all.length,resolved:all.length,external:0,ambiguous:0,missing:0}}
    const bytes=(n,label)=>`left((select string_agg(md5('${label}-${i}:'||n::text),'')from generate_series(1,${Math.ceil(n/32)})n),${n})`
    rows.push(`(${literal("template-"+i)},'Synthetic','Synthetic','Synthetic',${bytes(bodySize(i,5422514,783673),"html")},${bytes(bodySize(i,5062489,780979),"text")},${literal("synthetic-"+i)},true,${literal(refs[i].to.map(r=>r.literal).join("; "))},${literal(refs[i].cc.map(r=>r.literal).join("; "))},${literal(refs[i].bcc.map(r=>r.literal).join("; "))},${json(proof)})`)
  }await f.owner.query(`insert into public.email_templates(id,title,subject,folder,body_html,body_text,slug,is_active,to_recipients,cc_recipients,bcc_recipients,recipient_resolution)values ${rows.join(",")};`)}
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='changed@example.invalid'where id='c'||lpad('1',43,'0');");await f.settle(randomUUID())
  // Complete source-shaped arrays in EVERY historical JSON, not a giant
  // scalar padding blob; all75 snapshots are validated by the real function.
  for(let first=0;first<71;first+=4)await f.owner.query(`do $$declare value text;base jsonb;kind text;counts jsonb;padding integer;begin for i in ${first}..${Math.min(first+3,70)} loop
    kind:=case when i%2=0 then 'fcuno_raw'else 'fcuno_exchange_projection'end;
    select canonical_json::jsonb,item_counts into base,counts from public.outlook_exchange_truth_snapshots where snapshot_kind=kind order by created_at limit 1;
    padding:=greatest(0,floor((2667000-octet_length(base::text))/3461.0)::int-58);
    select jsonb_set(base,'{contacts}',jsonb_agg(item||jsonb_build_object('syntheticProperties',jsonb_build_object('syntheticMetadata',left(repeat(md5(i::text||':'||ordinality::text),100),padding)))order by ordinality))into base from jsonb_array_elements(base->'contacts')with ordinality as p(item,ordinality);
    value:=jsonb_set(base,'{contacts,0,syntheticHistoryVersion}',to_jsonb(i))::text;
    insert into public.outlook_exchange_truth_snapshots(snapshot_sha256,snapshot_kind,canonical_json,byte_length,item_counts)values(public.outlook_exchange_truth_sha256(value),kind,value,octet_length(value),counts);
    end loop;end;$$;`)
  const ledgerCount=await f.owner.one("select to_jsonb(count(*))from public.outlook_exchange_truth_ledger;")
  for(let first=ledgerCount;first<8630;first+=500)await f.owner.query(`do $$declare payload text;begin for i in ${first}..${Math.min(first+499,8629)} loop
    payload:=jsonb_build_object('synthetic',i,'padding',repeat('x',case when i=${ledgerCount} then 61741 else 3190 end-length(jsonb_build_object('synthetic',i,'padding','')::text)))::text;
    perform public.append_outlook_exchange_truth_event('synthetic-profile:'||i,'run_status',clock_timestamp(),null,null,null,null,payload);end loop;end;$$;`)
  f.run=randomUUID();await f.acquire();const packet=await f.packet()
  const volume=await f.owner.one(`select jsonb_build_object('contacts',(select count(*)from public.shared_addressbook_contacts),'groups',(select count(*)from public.shared_addressbook_groups),'members',(select count(*)from public.shared_addressbook_group_members),'templates',(select count(*)from public.email_templates),'refs',(select sum((recipient_resolution#>>'{counts,total}')::int)from public.email_templates),'toRefs',(select sum(jsonb_array_length(recipient_resolution#>'{refs,to}'))from public.email_templates),'ccRefs',(select sum(jsonb_array_length(recipient_resolution#>'{refs,cc}'))from public.email_templates),'bccRefs',(select sum(jsonb_array_length(recipient_resolution#>'{refs,bcc}'))from public.email_templates),'htmlBytes',(select sum(octet_length(body_html))from public.email_templates),'textBytes',(select sum(octet_length(body_text))from public.email_templates),'snapshotCount',(select count(*)from public.outlook_exchange_truth_snapshots),'snapshotBytes',(select sum(byte_length)from public.outlook_exchange_truth_snapshots),'ledger',(select count(*)from public.outlook_exchange_truth_ledger),'ledgerPayloadBytes',(select sum(octet_length(payload_canonical_json))from public.outlook_exchange_truth_ledger));`)
  return{packet,volume}
}
