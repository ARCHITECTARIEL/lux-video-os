# LUX marketing composition proof

This bounded 1920x1080, 5.24-second composition proves the division of responsibility:

- HeyGen supplies the already-rendered presenter performance.
- HyperFrames owns frame composition, LUX branding, animated titles, a lower third, background treatment, and the closing call to action.

The private presenter MP4 is intentionally absent from Git. The proof procedure stages an authorized private input into the ignored `assets/` directory, verifies its expected byte count and SHA-256, runs the pinned HyperFrames CLI, and keeps the output under ignored `.proof/` storage.

No provider submission, public asset URL, Production deployment, DNS change, or Stripe change is part of this composition.
