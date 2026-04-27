---
name: fill_and_verify
description: Fill a form (looked up by formId from the latest snapshot) with a values map keyed by field label, then assert post-submit conditions. Status ok if all checks pass, suspicious if any fail, failed if fill or submit threw.
type: playbook
categories: [form]
estimatedDurationMs: 5000
---

# Usage

Fill a form and assert post-submit conditions. Use when you want to test that a form saves correctly, navigates correctly, shows a success toast, or persists values.

# Inputs

- `formId` (required): the form ID from the latest snapshot
- `values` (required): map of field label (case-insensitive) to string value
- `submit` (optional, boolean): whether to submit after filling. Default: true
- `verify` (optional): array of verify checks — `url-changed`, `url-matches`, `success-toast`, `error-shown`, `value-persisted`, `redirect-to`
