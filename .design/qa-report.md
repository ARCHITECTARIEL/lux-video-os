# Visual QA report

## Golden screenshots

Eighteen current captures cover Photo, Video, Consent, Standard script, Standard quote and Premium script at 1440x1000,390x844 and320x740. See screenshot-manifest.json and browser-visual-checks.json. These are local mock-API states with synthetic media, not real provider output.

The root compared the rendered captures against the previous LUX baseline and the approved reference brief. Iterations corrected the Standard title field, mobile dialog width, initial step scroll, internal terminology and oversized empty video preview. Final visual verdict:92/100, pass.

## Browser checks

Python Playwright/Chromium captured the rendered pages with outbound services blocked. All 18 states had zero page errors and no horizontal overflow. The provider-ready identity and quote were explicit fixtures. No provider work or live render was submitted.

## Accessibility and interaction

The focused browser suites cover keyboard navigation, native dialog focus, separate consent validation, camera permission failures, recording cleanup, file preview, account-scoped recovery and price acceptance. The mobile permission explanation appears before the Record action; the footer is opaque and the dialog spans the viewport. Full-suite results are recorded in the execution note.

## Remaining risks

This is not a formal WCAG certification or a physical-device test. Real iPhone/Android media, HTTPS permissions, slow mobile upload and hosted processing require qualification before activation.
