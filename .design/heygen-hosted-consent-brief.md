# Hosted presenter consent design brief

Reference: Lazyweb consent-form search, including Oshi Health's informed-consent pattern (2026-10-07). The reference supports a short purpose statement, an explicit affirmative action, and a visible post-submission status. The Identity Studio already has these primitives; use its existing typography, colors, buttons, cards, and responsive layout.

- Place the hosted-consent step beside the affected identity's avatar status, not inside the six existing media/voice authorizations.
- State clearly that the depicted person must review a separate notice and record on HeyGen once. The account owner can prepare the invitation but cannot accept for them.
- Show distinct states for invitation, hosted link issued, returned, provider pending, accepted, rejected, and withdrawn. A return only prompts a provider status check.
- Keep raw provider URLs, group IDs, private media, tokens, and response bodies out of rendered text, local storage, and analytics.
- Use existing blue primary actions and warning/error surfaces. Keep status text in an accessible live region and controls keyboard reachable on desktop and mobile.
- Avoid new imagery and motion; the existing presenter card gives enough context. Verify rendered desktop and mobile layouts with screenshots before handoff.
