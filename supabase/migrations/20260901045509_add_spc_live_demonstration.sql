select pg_catalog.set_config('app.audit_actor_id', 'system:spc-presentation-deployment', true);
select pg_catalog.set_config('app.audit_actor_name', 'SPC presentation deployment', true);
select pg_catalog.set_config(
  'app.audit_context',
  jsonb_build_object(
    'pageId', 'spc-readme',
    'pageLabel', 'SPC PRESENTATION',
    'pagePath', '/spc/presentation',
    'action', 'publish-live-demonstration',
    'outcome', 'success'
  )::text,
  true
);

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
  visual_copy,
  duration_seconds,
  status,
  created_by_username,
  updated_by_username
)
select
  'live-demonstration-warm-up',
  50,
  'LIVE DEMONSTRATION',
  'WARM UP ACTIVITY',
  'WARM UP ACTIVITY',
  'Review a real bunker enquiry before the SPC live demonstration.',
  'Warm up activity. Review the enquiry carefully before we begin the live SPC workflow.',
  array['READ THE ENQUIRY', 'CHECK THE DETAILS', 'KEEP THE TRADER IN CONTROL'],
  'What should be checked before this enquiry is circulated?',
  'warm-up-enquiry',
  jsonb_build_array(
    jsonb_build_object('id', 'vessel', 'label', 'VESSEL', 'text', 'Raven Arrow'),
    jsonb_build_object('id', 'imo', 'label', 'IMO', 'text', '9574858'),
    jsonb_build_object('id', 'port', 'label', 'PORT', 'text', 'SGP'),
    jsonb_build_object('id', 'agent', 'label', 'AGENT', 'text', 'TBA'),
    jsonb_build_object('id', 'eta', 'label', 'ETA', 'text', '21ST - 23RD SEPTEMBER 2026'),
    jsonb_build_object('id', 'operational-note-1', 'label', 'OPERATIONAL NOTE 1', 'text', 'IF UNABLE TO OFFER FOR A DELIVERY 1 JANUARY, PLS OFFER BASED ON YR EARLIEST DELIVERY DATE.'),
    jsonb_build_object('id', 'operational-note-2', 'label', 'OPERATIONAL NOTE 2', 'text', 'OFFICIAL SAMPLES FOR DISPUTE RESOLUTION ARE TO BE TAKEN AT THE RECEIVING VESSELS MANIFOLD.'),
    jsonb_build_object('id', 'operational-note-3', 'label', 'OPERATIONAL NOTE 3', 'text', 'Buyer will appoint Lintec/Intertek to perform a Bunker Quantity Survey on this delivery.'),
    jsonb_build_object('id', 'operational-note-4', 'label', 'OPERATIONAL NOTE 4', 'text', 'The Bunker delivery is NOT to commence until the Surveyor is present and has performed pre delivery checks.'),
    jsonb_build_object('id', 'operational-note-5', 'label', 'OPERATIONAL NOTE 5', 'text', 'Note: In ports where procedures permit the vessel must receive a Certificate of Quality (COQ) for each supply of VLSFO.'),
    jsonb_build_object('id', 'spec', 'label', 'SPEC', 'text', 'ISO 8217 2017 VLSFO RMG 380 0.50%'),
    jsonb_build_object('id', 'quantity', 'label', 'QUANTITY', 'text', '300 - 400 METRIC TONS')
  ),
  120,
  'published',
  'system:spc-presentation-deployment',
  'system:spc-presentation-deployment'
where not exists (
  select 1
  from public.spc_presentation_chunks
  where lower(slug) = 'live-demonstration-warm-up'
);
