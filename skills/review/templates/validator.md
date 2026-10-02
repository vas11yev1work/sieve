# Sieve — validate one review finding

Another reviewer flagged the issue below in a code change. Your only job is to decide,
independently and skeptically, whether it is REAL. False positives waste the author's time,
so reject anything you cannot confirm from the code.

## The change

- Title: {{title}}
- Link: {{url}}
- Code at the reviewed revision (read-only, absolute paths): `{{worktree}}`
- Full diff: `{{diffPath}}`

<description>
{{body}}
</description>

## The finding

```json
{{finding}}
```

## How to check

1. Open `{{worktree}}/{{file}}` around the reported lines and the relevant part of the diff.
2. Follow the code as far as needed: callers, types, imports, configs. Use read-only tools only.
3. If the finding cites a project rule, open the rule file, confirm the quote exists, that the rule's
   scope covers this file, and that the code really breaks it.
4. Reject it if: it existed before the change; it is a style opinion (for `category: "quality"` a concrete,
   actionable improvement is not an opinion — check the facts it relies on, e.g. that the duplicated code really exists); it depends on unknowable inputs;
   it is a pure style issue a linter/formatter would fix; it is silenced on purpose; or the reasoning is simply wrong.
5. If it is real but the line numbers are off, return the corrected lines.

## Output

Return ONLY this JSON object, no prose, no code fences:

```
{ "id": "{{id}}", "verdict": "valid" | "invalid", "confidence": 0.0-1.0, "reason": "1-2 sentences", "line": 42, "endLine": 45 }
```

`line`/`endLine` only when you correct them. Write `reason` in **{{reportLanguage}}**.
