---
name: form_persistence_roundtrip
description: Fill form, submit, navigate away, come back, verify values still there. Catches "Saved!" lies (toast appears, data didn't actually save).
type: playbook
categories: [form]
estimatedDurationMs: 12000
---

# Usage

The completionist's signature move. Submits valid values, leaves the route, returns, and checks the form fields are repopulated with the submitted values. If they're not, the save was a lie — file a critical finding.

# Inputs

- `formId` (required): form ID from the latest snapshot
- `values` (required): map of field label to value
- `awayUrl` (optional): URL to navigate to between submit and verify (default: same-origin root)

# Outcome

- `ok` if every submitted value is still present on return
- `suspicious` with `mismatches` evidence if any value was lost — file a critical finding (silent data loss)
