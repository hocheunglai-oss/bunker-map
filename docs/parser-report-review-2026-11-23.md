# Parser Report Review - 23 November 2026

Four FCUNO reports were submitted for AI review. The existing SPC JONATHAN STAR
case is still pending owner review and is excluded from completion.

| Case | Correction |
| --- | --- |
| TEH PEACE | Recognize `Demand port`, retain the explicit Shanghai terminal as `shanghai (wai gao qiao)`, and normalize the same qualifier in AI output and fields. |
| XIN HAI TONG 32 | Recognize the vessel after a quote-request introduction joined to its MV line by worksheet cleanup. Exclude email signoffs from slash-header vessel guesses. Normalize `Gibralter` to `gibraltar`. |
| FAN ZHOU 7 | Add Malta to the shared port index so the inline ETA/port window retains its port. |
| YUE DIAN 81 | Recognize a standalone indexed port followed by a parenthesized note; `HONG KONG (SLA)` shortens to `hk`. Preserve genuine terminal-qualified port names before dropping notes. |

The shared extraction and port index serve both FCUNO and SPC. Worksheet AI
output and port fields use the indexed terminal label; SPC retains its current
simple port-field formatting and normalizes the terminal-qualified alias.
Stored enquiry text is not rewritten.

TEH PEACE IMO 9868170 was verified in the
[ClassNK register](https://www.classnk.or.jp/register/regships/one_dsp.aspx?imo=9868170).
YUE DIAN 81 IMO 9161041 was verified in
[VesselFinder](https://www.vesselfinder.com/vessels/details/9161041).
Neither IMO is present in its report's raw enquiry; deterministic parsing leaves
it absent. Tests verify the full approved result when the verified lookup value
is supplied. No vessel-specific IMO mapping was added.

Focused regressions exercise all four raw and stored cleaned inputs, SPC output,
email-signoff rejection, parenthesized note handling, and AI field/output
normalization through the actual route with synthetic provider responses.
No paid AI test or model fine-tuning is part of this review.

Verification: 165 focused parser, AI-route, history and review-queue tests passed;
576 actual worksheet checks passed in isolated Chromium and WebKit across
1440px, 320px and 390px widths, light and dark modes. Browser authentication,
port GET and theme variables were synthetic; no AI, report or send requests
were made. Physical phones and the complete signed-in shell were not tested.
The browser harness now declares UTF-8 so full-width punctuation and Unicode
date dashes are decoded as they are in production.

Replay of all 79 stored reports changed only these four open FCUNO cases;
previously closed cases were unchanged. Focused TypeScript lint and the
production build passed. Repository lint completed with zero errors and 112
existing warnings. Direct CommonJS lint is blocked by the existing ESLint
plugin scoping configuration; both CommonJS files passed Node syntax checks.

Complete only the four pending-AI FCUNO reports after verifying the production
deployment. Preserve raw text, original parser/AI output, notes and corrections,
and use the atomic version-checked review RPC to prevent overwriting later edits.
