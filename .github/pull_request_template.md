## Intent

Describe why this change is needed.

## Release gates

- [ ] Billing, pilot, and finishing gates remain disabled unless a fresh production receipt is attached.
- [ ] Authorization, transaction, private-media, workflow, and replay tests pass.
- [ ] Logs contain correlation IDs and no customer secrets.
- [ ] `npm run build:preview` passes (packaging only); production promotion separately requires the reviewed DB target, live schema proof, workflow boundary and P0 gate.

## Verification

List exact commands, evidence, and known gaps.
