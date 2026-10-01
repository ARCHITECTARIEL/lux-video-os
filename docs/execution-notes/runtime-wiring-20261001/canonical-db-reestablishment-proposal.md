# Canonical production database: proposed recovery

Prepared October 1, 2026. **Superseded for target discovery.** The owner approved the exact integrated target and read-only inspection. Historical credential-copy provenance subsequently confirmed the canonical target, so a secret reset is unnecessary for that confirmation. Read [the completed investigation](canonical-db-investigation.md). The inspection found four missing migrations; no environment update or deployment below is approved or executed. The original proposal is retained as history.

The owner does not know where the original canonical production connection was retained. Vercel returns no value for the Sensitive production `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. The old checkout `.env.local` points to another Neon project. Existing integration and runtime timing evidence identifies a leading candidate, not the secret's actual contents.

## Proposed intended target

- Application: Vercel `lux-video-os`, project `prj_jZYuVgIAk1cwx8MRKE5kGNxn4ItW`, team `team_rTOCyHyMxhhdoLk4LtT2kD9X`.
- Neon integration: `neon-byzantium-drum`, project `still-voice-83326863`.
- Branch: `br-broad-sunset-awrsmiwa` (`main`).
- Endpoint family: `ep-autumn-morning-awa4hmb6`, region `aws-us-east-1`.
- Database: `neondb`; role: `neondb_owner`.
- Canonical pooled host: `ep-autumn-morning-awa4hmb6-pooler.c-12.us-east-1.aws.neon.tech`.
- Unpooled host: `ep-autumn-morning-awa4hmb6.c-12.us-east-1.aws.neon.tech`.

These are nonsecret control-plane observations. Explicitly choosing this target would establish a new canonical configuration; it would not retrospectively prove what the hidden previous value contained.

## Bounded first action to review

Designate this exact target as the intended production database, retrieve its existing connection credentials through the authenticated Neon connection interface into a protected local file, and run read-only identity/migration/schema inspection. Do not reset the database password, query customer records, apply migrations, write Vercel variables, or deploy in this first action. Report the precise missing migrations or schema differences against the repository's eleven-migration baseline.

If the read-only inspection fails, stop and prepare a specific repair. Never overwrite the expected schema lock with production drift. Do not install the verification database URL in production.

## Separate configuration action after inspection

Prepare a two-variable production-only update for `DATABASE_URL` and `DATABASE_URL_UNPOOLED` using the inspected target. Preserve Preview and Development entries and all other configuration. Keep the values secret. Record variable IDs, timestamps, target metadata and protected evidence references rather than connection strings.

This update affects future deployments. It does not alter the environment captured by the existing deployment. Activation therefore needs a separately reviewed deployment scope. Do not deploy the dirty current candidate merely to activate a connection change. First establish the exact source/artifact and all applicable release gates. The existing observed production deployment is `dpl_AEUWrAaSPEyvNjkkZxCbDAg427WP`; recheck that identity immediately before any action.

Rollback must retain the existing deployment and alias baseline. The hidden prior Sensitive values cannot be reconstructed from metadata; do not claim that a simple variable rollback is available. A deployment rollback and project-level configuration rollback are distinct operations.

## Evidence required before calling the connection confirmed

1. Independent Neon project/branch/endpoint/database/role readback.
2. Protected canonical connection values validated against that intended target, plus SQL `current_database()` and `current_user` identity and strict schema results.
3. Exact Vercel production variable update receipts, if a reset is needed.
4. An authorized deployment using those values and a runtime verification tied to that deployment and stable alias.

No database schema write, provider credential change, HeyGen upload/clone/render/delete, public release, or paid generation is included in this proposal.
