---
name: form_fuzz_validation
description: Fuzz-test a form with malformed inputs (empty, very long, XSS, SQLi, control chars). Detects 5xx, stack traces, missing validation, broken error handling.
type: playbook
categories: [form, security]
estimatedDurationMs: 30000
---

# Usage

Submit a form many times with different malformed inputs and detect validation / error-handling defects.

# When to use

Whenever the snapshot shows a form (`Forms (N>0)`), call this BEFORE you decide the form is "fine." Forms that look correct often fail under bad input. This is the primary tool for finding QA-class bugs:

- broken validation (empty submits accepted)
- missing length limits (overflow strings accepted)
- stored XSS (script payload saved without sanitisation)
- SQL injection (single quote breaks the query)
- stack-trace leaks (server crash on bad input)
- missing rate-limit / double-submit handling

# Inputs

- `formId` (required): form ID from the latest snapshot
- `vectors` (optional): array of vector IDs to limit to. Defaults to ALL. Available: `empty`, `whitespace`, `long`, `xss-classic`, `xss-img`, `sqli-or`, `sqli-drop`, `newline-injection`, `null-byte`, `unicode-rtl`

# Outcome

- `ok` if every vector is gracefully handled (form shows error for invalid input, no 5xx, no stack traces)
- `suspicious` if ANY vector exposes a defect — each suspicious vector is a candidate finding
