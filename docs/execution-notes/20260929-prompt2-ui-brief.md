# Prompt 2 status behavior brief

Scope: two status conditions in the existing My Videos cards; no visual redesign.

Reference evidence: Lazyweb quick search `video library deleted unavailable video processing status` returned VEED media-library/trash reference `veed_45a6d69c-d964-4945-b991-1b27d2af12b2.png` (site 246487) and Pool indexing/processing reference. Search descriptions provide limited supporting context, not a full visual audit. Primary reference is the existing Studio state model, card markup and tests.

Decision: preserve current typography, color tokens, layout, hierarchy, images, motion, responsive behavior and accessible controls. Unvalidated completed output says acceptance pending. Validated but deleted output remains terminal and says unavailable, with no preview/download actions. Never suggest a deleted item is still processing. No dependency or new component.

Verification: browser assertions against real route-generated DTOs in synthetic persistence tests; desktop/mobile screenshots and existing result-card regressions. This is behavior evidence, not real provider or production acceptance.
