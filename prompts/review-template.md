<!--
MANDATORY: This template has two parts.
1) The markdown review (Summary, Risk, Issues, Suggestions, Architecture).
2) A fenced ```ai-review-findings JSON block at the very end. ALWAYS emit it,
   even when there are zero line-addressable findings (use an empty array).
   Without it, no inline line comments are posted on the PR.
-->

## Review

### Summary
<!-- One sentence: what this PR does. -->

### Risk
<!-- **LOW** | **MEDIUM** | **HIGH** -- one sentence why. -->

### Issues
<!-- Each item is one line:
- **critical** `file.ts:42` -- description
- **warning** `file.ts:17` -- description
- **nit** `file.ts:5` -- description
Write "None." if clean. -->

### Suggestions
<!-- Each item is one line:
- `file.ts` -- suggestion
Write "None." if nothing worth suggesting. -->

### Architecture
<!-- One sentence if the PR changes structure or cross-cutting patterns. Omit entirely if not applicable. -->

## Inline findings

<!--
MANDATORY: emit a ```ai-review-findings fenced JSON block below listing every
line-addressable finding from the Issues section. GitHub line comments are
generated from this block. If none, emit `[]`.

Schema per object:
  - file   (string, relative repo path as shown by `git diff --name-only`)
  - line   (integer, line number in the PR head / new code)
  - severity (one of "blocker" | "warning" | "nit" | "good")
  - message (short sentence; no severity emoji)

Only include findings that map to a specific file+line. Findings about the PR
as a whole (architecture, summary) stay in the prose above and MUST NOT appear
in the JSON block.
-->

```ai-review-findings
[]
```
