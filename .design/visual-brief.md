# Visual brief: phone enrollment and scripts

Status: approved
Arbiter: root, September 30, 2026

## Goal and audience
Customers on phones or desktop enroll once using exactly a photo and a video. The photo determines the finished presenter's appearance. Separate explicit consent permits audio extraction and reusable voice creation. Standard and Premium then accept scripts without repeated media uploads.

## Visual direction
Preserve the existing LUX studio: Geist, white surfaces, blue primary actions, bordered guidance panels and clear status labels. This is a functional update. Local baseline screenshots govern visual continuity. Edits contributes the pattern of explaining permissions before requesting them; Sprig contributes explicit recording and preview controls. Do not copy either brand.

## Typography and color
Reuse identity.css and studio.css tokens and local Geist fonts. Body and consent text: at least 14px with 1.5 line height; use 12px only for secondary metadata. Keep primary #2458d3, text #111827, existing gray/white surfaces and semantic status colors. Errors must have text, not color alone. Keep visible keyboard focus and an opaque sticky footer.

## Layout and responsiveness
Five steps: Photo, Video, Consent, Creating, Ready. Desktop retains the progress row and split guidance/preview layout. At 600px and below, use a compact current-step label such as '2 of 5: Video', segmented progress, one column, and a dialog that fills the viewport with safe-area padding. Controls must be at least 44px tall; prefer 48px capture actions on mobile. Prevent horizontal overflow at 390px and 320px. Focused controls must remain above the footer and mobile keyboard.

## Media and motion
Keep the full photo visible in a stable preview area. Video uses controls, playsinline and preload=metadata, without autoplay. Explain camera and microphone use before the explicit Record tap. Show Record, Stop, Preview, Retake and Use states with a visible timer that does not flood screen-reader announcements. Permission denial must offer upload or native phone capture as a fallback. Stop all tracks on every exit, error or hidden-page transition, and discard late permission results after cancellation. Respect reduced motion; add no decorative animation.

## Consent and recovery
Use distinct unchecked permissions for photo likeness, video processing/audio extraction, reusable voice cloning, provider processing and retention/archive acknowledgement. Upload alone does not authorize extraction or cloning. Show real upload, extraction and provisioning stages; do not invent percentages. Preserve valid captures when a replacement fails. Confirm discard of unsaved media. Persist enrollment IDs and receipts so reloads and retries resume existing work rather than duplicate it. Do not claim provider readiness after local processing.

## Script interface
Both tiers show title and script, a ready owned presenter, format, and server price/quote confirmation. Preserve separate drafts when switching tiers. Remove per-render audio upload. Offer only server-supported controls; do not silently discard unsupported Premium settings or claim higher quality without evidence. Keep provider internals out of customer messages. Authentication, readiness and pricing failures must be understandable and must not spend credits.

## Acceptance
Capture desktop 1440x1000 and mobile 390x844 views of capture, consent, processing, ready and script states. Verify keyboard focus, dialog semantics, touch sizes, overflow, permission timing, track cleanup, preservation of valid files/drafts, explicit consent, refresh recovery and idempotent requests. Visual verdict must reach 90 against this brief and the local baseline. Browser mocks verify interaction only; they do not establish real provider output or voice quality.
