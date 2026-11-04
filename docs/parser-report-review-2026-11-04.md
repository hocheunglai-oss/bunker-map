# Parser Report Review - 4 November 2026

Reviewed all 74 retrievable reports against the latest main branch. Six reports
were open: five FCUNO reports awaiting AI review and one SPC report awaiting
the owner's correction. The 68 already-closed reports have unchanged parser
output with this patch.

| Report | Finding and correction |
| --- | --- |
| Macau Star | Recover `1 3th sep` as `13 sep` within the explicit 8-13 September window. |
| Chemical Marketer | Exclude the `(Chemical tanker, IMO: ...)` vessel-type annotation from the name. |
| Southern Narwhal | Parse both quantities in `Grade: VLSFO(0.5% Max) 300mt // LSMGO(0.1% Max) 110mt`. |
| Heng Yuan Fa Zhan | Parse `Oct-7-14th` using October rather than the current month. Retain the manually approved 180CST MAX setting. |
| Melody Selmer | Add Pasir Gudang to the shared port index and accept indexed ports after `At:`. Ordinary phrases such as `At: present` remain excluded. |
| Jonathan Star (SPC) | A repeated sulphur-only VLSFO specification must not take the following LSMGO quantity. Preserve 392 MT VLSFO and 8 MT LSMGO. This case remains in owner review until submitted to AI review. |

Southern Narwhal's approved IMO 9715995 was verified against the
[ClassNK register](https://www.classnk.or.jp/register/regships/one_dsp.aspx?imo=9715995).
It is absent from the raw enquiry. The deterministic parser continues to leave
it empty; supplying the verified lookup value produces the exact approved
correction. No vessel-specific IMO mapping was added.

Both platforms use the changed shared helpers. AI FIX instructions include the
same lessons. This is a parser and prompt update, not model fine-tuning; no new
paid AI evaluation was performed. Historical AI outputs and user corrections
remain preserved in the reports.

Validation: all six reported formats are covered by regression tests for both
platforms, alongside the historical parser, metadata and review-workflow tests.
The isolated worksheet browser suite covers Chromium and WebKit at 1440, 320
and 390 pixels in light and dark modes, with synthetic signed-in authentication.
These checks do not represent physical phone testing or live signed-out UI
verification. The new report regressions run in both `test:parsers` and CI.

After production deployment is verified, only the five reports already in
`pending-ai` are eligible for completion. Review writes must check each stored
`updated_at` version so a concurrent user correction cannot be overwritten.
