create table if not exists public.spc_presentation_chunks (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  sort_order integer not null default 0,
  section_label text not null default 'CHAPTER',
  title text not null,
  summary text not null default '',
  narration text not null default '',
  key_points text[] not null default '{}',
  q_and_a_prompt text not null default '',
  visual_kind text not null default 'video',
  video_path text,
  video_mime_type text,
  video_bytes bigint,
  narration_path text,
  narration_mime_type text,
  narration_bytes bigint,
  duration_seconds integer,
  media_version integer not null default 1,
  revision integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  created_by_username text,
  updated_by_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint spc_presentation_chunks_duration_check
    check (duration_seconds is null or duration_seconds between 0 and 3600),
  constraint spc_presentation_chunks_media_version_check
    check (media_version > 0),
  constraint spc_presentation_chunks_revision_check
    check (revision > 0)
);

create unique index if not exists spc_presentation_chunks_slug_key
on public.spc_presentation_chunks(lower(slug));

create index if not exists spc_presentation_chunks_status_order_idx
on public.spc_presentation_chunks(status, sort_order, created_at);

drop trigger if exists set_spc_presentation_chunks_updated_at
on public.spc_presentation_chunks;
create trigger set_spc_presentation_chunks_updated_at
before update on public.spc_presentation_chunks
for each row
execute function public.set_spc_updated_at();

alter table public.spc_presentation_chunks enable row level security;

drop policy if exists "spc_presentation_chunks_no_public_access"
on public.spc_presentation_chunks;
create policy "spc_presentation_chunks_no_public_access"
  on public.spc_presentation_chunks
  for all
  using (false)
  with check (false);

revoke all on table public.spc_presentation_chunks from anon, authenticated;
grant select, insert, update, delete on table public.spc_presentation_chunks to service_role;

insert into public.spc_presentation_chunks (
  slug,
  sort_order,
  section_label,
  title,
  summary,
  narration,
  key_points,
  q_and_a_prompt,
  visual_kind,
  duration_seconds,
  status,
  created_by_username,
  updated_by_username
)
values
  (
    'daily-pressure',
    10,
    'PROBLEM 1',
    'LARGE DAILY ENQUIRY VOLUME',
    'Every enquiry may be commercially important, but repeated reading and preparation fragment the trader''s attention.',
    'A purchasing center can receive a large number of enquiries in one day. Each message may be commercially important, and each may need a fast response. The difficulty is not simply the number on the screen. It is the repeated need to stop, read, understand, and decide what to do next. As the queue grows, attention becomes fragmented. Routine preparation takes time away from comparing suppliers, checking market conditions, and making sound trading decisions.',
    array[
      'Every message needs fast and accurate review.',
      'Repeated preparation fragments attention.',
      'Trading judgment should receive more time than routine retyping.'
    ],
    'Where does the team lose the most time when enquiry volume rises?',
    'daily-pressure',
    48,
    'published',
    'codex',
    'codex'
  ),
  (
    'varied-formats',
    20,
    'PROBLEM 2',
    'ENQUIRIES ARRIVE IN DIFFERENT FORMATS',
    'The same commercial facts arrive in different orders, abbreviations, and message styles.',
    'Enquiries do not arrive in one clean template. One buyer sends three short lines. Another writes a paragraph with abbreviations. A third enquiry includes several grades, a quantity range, and a fuel specification inside the remarks. The commercial facts may be the same, but their order and wording are different. Before the enquiry can be circulated, the trader must find the vessel, delivery window, product, quantity, and constraints. This work is repetitive, but it cannot be careless. A decimal point, a range, or the words 180CST MAX can change the meaning.',
    array[
      'Vessel, date, grade, quantity, and constraints must be found quickly.',
      'Ranges and decimal points must remain exact.',
      'A standard format helps only when a trader verifies it.'
    ],
    'Which enquiry details are most dangerous to misread?',
    'varied-formats',
    52,
    'published',
    'codex',
    'codex'
  ),
  (
    'whatsapp-load',
    30,
    'PROBLEM 3',
    'MANY WHATSAPP WINDOWS AT ONCE',
    'Supplier traders must keep each conversation attached to the correct enquiry while replies arrive at different speeds.',
    'Each supplier trader may be managing many WhatsApp conversations at the same time. Different suppliers reply at different speeds. One asks for the IMO number. Another gives a short validity. Another is checking barge availability. The trader must remember which conversation belongs to which enquiry while new messages continue to arrive. The more windows that are active, the easier it is to lose time, repeat work, or place information in the wrong conversation.',
    array[
      'Each chat has different timing and context.',
      'New enquiries arrive while earlier quotations remain active.',
      'The existing human communication workflow must remain controlled.'
    ],
    'What information is hardest to keep attached to the correct WhatsApp chat?',
    'whatsapp-load',
    50,
    'published',
    'codex',
    'codex'
  ),
  (
    'prompt-structure',
    40,
    'FIRST AI STEP',
    'DESCRIBE THE WORK BEFORE ASKING FOR A SOLUTION',
    'A useful first prompt gives context, identifies friction, states safety constraints, and asks for one practical step.',
    'Before asking AI for a solution, describe the work clearly. Give the business context. Name the friction to remove. State the safety constraints, including human verification and no automatic sending. Then ask for one practical first step. This keeps the answer focused and prevents the discussion from jumping too quickly into a large system that nobody has tested.',
    array[
      'Give the business context.',
      'Name the repeated friction.',
      'State the safety boundaries.',
      'Ask for one small, testable improvement.'
    ],
    'What constraint would you add before asking AI for a trading solution?',
    'prompt-structure',
    45,
    'published',
    'codex',
    'codex'
  ),
  (
    'live-prompt',
    50,
    'DEMONSTRATION',
    'BUILD THE FIRST PROMPT',
    'The prompt is written in small parts so the audience can see why each instruction is included.',
    'Begin with the context: a bunker purchasing team receives many enquiries every day. Describe the two main sources of delay: different message formats and many WhatsApp windows. Add the operating constraints: keep the existing WhatsApp workflow and require a human to check every message before sending. Finally, ask for only the first practical improvement, explained in simple terms.',
    array[
      'Show the real prompt being written.',
      'Pause after each instruction.',
      'Do not ask AI to design the whole platform at once.'
    ],
    'Would the prompt be clear to someone who does not work in bunker trading?',
    'live-prompt',
    55,
    'published',
    'codex',
    'codex'
  ),
  (
    'ai-response',
    60,
    'DEMONSTRATION',
    'REVIEW THE AI RESPONSE',
    'The first useful suggestion is to standardize a draft before a human decides whether to send it.',
    'The response sets an important boundary: do not begin by automating the sending of messages. Begin by standardizing every enquiry before a human sends it. AI reads the raw message, extracts the important details, and prepares one consistent request for quotation. The trader reviews the draft, corrects anything that is wrong, and decides whether to send it.',
    array[
      'AI prepares; the trader decides.',
      'The first use case is intentionally narrow.',
      'The response is a hypothesis to test, not a final design.'
    ],
    'Which part of the AI response should be tested first with real enquiries?',
    'ai-response',
    55,
    'published',
    'codex',
    'codex'
  ),
  (
    'human-review',
    70,
    'WORKFLOW',
    'KEEP THE TRADER IN CONTROL',
    'Automation is limited to preparation; commercial communication remains a human decision.',
    'The proposed workflow is deliberately controlled. A raw enquiry enters in any format. AI prepares a standard draft. The trader checks every detail, corrects the draft, and chooses whether to send it. The system should make missing or uncertain information visible rather than hiding it.',
    array[
      'No automatic sending.',
      'Missing information remains visible.',
      'Every commercial detail can be corrected before use.'
    ],
    'What must always remain a human decision in this workflow?',
    'human-review',
    42,
    'published',
    'codex',
    'codex'
  ),
  (
    'chapter-takeaway',
    80,
    'CHAPTER 1',
    'ONE LOW-RISK USE CASE TO TEST',
    'Start with enquiry preparation, measure the mistakes, and improve the prompt using difficult real examples.',
    'We have not built a complete platform and we have not handed decisions to AI. We have identified one low-risk task that can be tested with real enquiries. The next step is to test the idea against difficult examples, record where it fails, and improve the prompt without removing human verification.',
    array[
      'Start small.',
      'Test with real difficult examples.',
      'Measure errors before expanding automation.'
    ],
    'What difficult enquiry should be used as the first test case?',
    'chapter-takeaway',
    38,
    'published',
    'codex',
    'codex'
  )
on conflict (lower(slug)) do nothing;

do $$
begin
  if to_regprocedure('public.audit_enable_table(regclass)') is not null then
    perform public.audit_enable_table('public.spc_presentation_chunks'::regclass);
  end if;
end $$;
