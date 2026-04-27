---
name: walk_wizard
description: Step through a multi-step wizard. stepInputs[i] is the field-values map for step i+1. Clicks Next between steps and Finish on the last step when expectFinish is true.
type: playbook
categories: [wizard]
estimatedDurationMs: 12000
---

# Usage

Step through a multi-step wizard with caller-supplied per-step field inputs. Clicks Next between steps and Finish on the last step. Status: `ok` on completion, `suspicious` if stuck mid-walk, `failed` if `wizardId` is unknown.

# Inputs

- `wizardId` (required): the wizard ID from the latest snapshot
- `stepInputs` (required): array of objects, one per step; each is a map of field label to value
- `expectFinish` (optional, boolean): whether to click Finish on the last step. Default: true
