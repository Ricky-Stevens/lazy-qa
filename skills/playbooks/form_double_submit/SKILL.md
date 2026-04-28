---
name: form_double_submit
description: Submit a form twice in quick succession to detect missing idempotency (duplicate records, double charges, double notifications).
type: playbook
categories: [form, chaos]
estimatedDurationMs: 5000
---

# Usage

Fill a form, then click submit TWICE in quick succession (<100ms). If both submits succeed without a rate-limit / idempotency block, the backend likely created duplicates — file a finding.

# Inputs

- `formId` (required): form ID from the latest snapshot
- `values` (required): map of field label to value (same shape as fill_and_verify)

# Outcome

- `suspicious` if both submits succeed with no error indicator — file a finding describing the duplicate-submit risk and verify the backend
- `ok` if the form blocks the second submit (error visible, only one success)
