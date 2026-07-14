alter table public.spc_presentation_chunks
add column if not exists visual_copy jsonb not null default '[]'::jsonb;

alter table public.spc_presentation_chunks
drop constraint if exists spc_presentation_chunks_visual_copy_check;

alter table public.spc_presentation_chunks
add constraint spc_presentation_chunks_visual_copy_check
check (jsonb_typeof(visual_copy) = 'array');

update public.spc_presentation_chunks
set
  visual_copy = jsonb_build_array(
    jsonb_build_object('id', 'slide-1-topic', 'label', 'SLIDE 1 - TOPIC', 'text', 'INCORPORATE AI INTO TRADING'),
    jsonb_build_object('id', 'slide-1-level', 'label', 'SLIDE 1 - LEVEL', 'text', 'INTERMEDIATE'),
    jsonb_build_object('id', 'slide-2-heading', 'label', 'SLIDE 2 - HEADING', 'text', 'THE ROLE OF AI'),
    jsonb_build_object('id', 'slide-2-focus', 'label', 'SLIDE 2 - MAIN POINT', 'text', 'TRADERS REMAIN IN CONTROL'),
    jsonb_build_object('id', 'slide-2-boundary-one', 'label', 'SLIDE 2 - BOUNDARY 1', 'text', 'NOT REPLACING TRADERS'),
    jsonb_build_object('id', 'slide-2-boundary-two', 'label', 'SLIDE 2 - BOUNDARY 2', 'text', 'NOT CHANGING EVERY WORKFLOW'),
    jsonb_build_object('id', 'slide-2-support', 'label', 'SLIDE 2 - SUPPORT', 'text', 'AI SUPPORTS PREPARATION'),
    jsonb_build_object('id', 'slide-3-heading', 'label', 'SLIDE 3 - HEADING', 'text', 'CONTROLLED IMPROVEMENT'),
    jsonb_build_object('id', 'slide-3-step-one', 'label', 'SLIDE 3 - STEP 1', 'text', 'DAILY CHALLENGE'),
    jsonb_build_object('id', 'slide-3-step-two', 'label', 'SLIDE 3 - STEP 2', 'text', 'AI THINKING PARTNER'),
    jsonb_build_object('id', 'slide-3-step-three', 'label', 'SLIDE 3 - STEP 3', 'text', 'TRADER DECISION'),
    jsonb_build_object('id', 'slide-3-outcome-one', 'label', 'SLIDE 3 - OUTCOME 1', 'text', 'LESS ROUTINE PREPARATION'),
    jsonb_build_object('id', 'slide-3-outcome-two', 'label', 'SLIDE 3 - OUTCOME 2', 'text', 'HUMAN JUDGEMENT'),
    jsonb_build_object('id', 'slide-3-outcome-three', 'label', 'SLIDE 3 - OUTCOME 3', 'text', 'MORE COMMERCIAL FOCUS'),
    jsonb_build_object('id', 'slide-3-closing', 'label', 'SLIDE 3 - CLOSING', 'text', 'AI PREPARES. THE TRADER DECIDES.')
  ),
  revision = revision + 1,
  updated_by_username = 'codex'
where lower(slug) = 'introduction';
