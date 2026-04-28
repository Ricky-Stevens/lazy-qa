---
name: form_required_field_check
description: Submit a form completely empty; check that EACH required field shows an error. Detects partial / missing required-field validation.
type: playbook
categories: [form]
estimatedDurationMs: 4000
---

# Usage

After landing on a form, call this BEFORE filling it. It clears every text field and submits, then checks for error indicators. Catches:
- Forms that show only one error when multiple fields are missing
- Forms that accept empty submits silently (missing all validation)
- Forms that show only a top-level error with no per-field hint

# Inputs

- `formId` (required): form ID from the latest snapshot

# Outcome

- `ok` if the empty submit was rejected with an error indicator
- `suspicious` if the submit succeeded silently or surfaced no error — file a finding
