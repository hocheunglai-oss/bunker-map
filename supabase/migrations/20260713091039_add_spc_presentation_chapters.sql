alter table public.spc_presentation_chunks
add column if not exists chapter_label text not null default 'CHAPTER 1';

update public.spc_presentation_chunks
set chapter_label = 'CHAPTER 1'
where btrim(chapter_label) = '';

insert into public.spc_presentation_chunks (
  slug,
  sort_order,
  chapter_label,
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
values (
  'introduction',
  0,
  'INTRODUCTION',
  'INTRODUCTION',
  'INCORPORATE AI INTO TRADING',
  'Begin with practical trading pressure, then use AI as a controlled thinking partner while keeping commercial judgement with the trader.',
  'AI is already changing how information is processed, but this session is not about replacing traders or changing every workflow at once. We will begin with three practical pressures inside a purchasing center: enquiry volume, inconsistent message formats, and simultaneous WhatsApp conversations. Then we will use AI as a thinking partner to identify one controlled improvement. The goal is simple: reduce routine preparation, preserve human judgement, and give traders more time for commercial decisions.',
  array[
    'Begin with the real operating pressure.',
    'Use AI to prepare and structure information.',
    'Keep commercial judgement with the trader.'
  ],
  'Before we begin, where does routine preparation consume the most time today?',
  'chapter-intro',
  36,
  'published',
  'codex',
  'codex'
)
on conflict (lower(slug)) do nothing;
