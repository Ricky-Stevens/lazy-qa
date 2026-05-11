---
name: visual_regression_check
description: Capture a viewport screenshot and compare against a stored baseline. Reports suspicious when visual changes exceed threshold (>1% difference). Automatically creates baselines for new routes.
type: playbook
categories: [discovery]
estimatedDurationMs: 3000
---

# Usage

Captures a viewport screenshot of the current page and compares it against a stored baseline from a previous run. If no baseline exists, the current screenshot becomes the new baseline. If the visual difference exceeds 1%, reports `suspicious` with the diff percentage.

Useful for detecting: layout shifts, missing elements, broken styles, unexpected content changes, broken images, CSS regressions.

# Inputs

- `route` (required): The URL of the page to screenshot and compare.
