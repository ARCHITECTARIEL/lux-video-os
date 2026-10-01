# Next action: rehearse the four pending production migrations

October 1, 2026. **Prepared, not executed.** Current authority covers production read-only inspection only.

The canonical target is confirmed by [historical provenance and fresh inspection](canonical-db-investigation.md): `still-voice-83326863` / `br-broad-sunset-awrsmiwa` / `neondb`. The seven applied migration hashes and timestamps match the repository exactly. The remaining files, in journal order, are:

| Migration | Current checkout SHA-256 |
| --- | --- |
| `0007_exotic_bruce_banner.sql` | `8ed60d68556a7904caea9389709d89e3cf2f3ab656478e840e9805afba8c1593` |
| `0008_ambiguous_scalphunter.sql` | `918caa8e75e0f2b473300db8b0836b089045165e40ba97ad00ffdf7ed04ac575` |
| `0009_absurd_meteorite.sql` | `7256bfa12b7393def52fcb93ff17c5f603402d9b1963767bd22a147d9ea8434f` |
| `0010_provider_source_binding.sql` | `f57dd5af8e4cc8fc2743eccde90e6037d134ebcff9bae3e067ad8291a2a5de28` |

The first two add phone enrollment and its reconciliation receipts. The last two add the provider provenance ledger, lifecycle guards and source binding. Together the expected catalogue has 27 tables; production currently has 16. Checkout hashes above include the current line endings; the strict checker accepts only the exact LF/CRLF equivalents of each journal migration.

1. Prepare a bounded disposable rehearsal target reproducing the production seven-migration baseline and relevant existing-data constraints. Creating a production-derived Neon branch is a separate provider action requiring its exact scope; do not silently clone production data.
2. Rehearse `0007` through `0010` in journal order using the existing Drizzle migration semantics. Never rewrite applied migrations, manually invent journal rows, disable lifecycle triggers, or recapture production drift into the schema lock.
3. Verify the exact eleven-migration journal, structural fingerprint and 27-table catalogue against `config/database-schema.lock.json`. Exercise existing account/identity/render records through the new constraints. Capture rollback and lock-duration evidence before preparing production execution.
4. Present the exact production migration command, reviewed source hashes, target manifest, restore point and abort conditions for owner approval. Use the protected credential path recorded in the investigation; never paste its contents into a command or chat.
5. After an authorized application, run strict production verification again. A passing migration check alone does not enable HeyGen, deploy the candidate or satisfy provider canaries, CI, private storage, rollback and release gates.

The fresh inspection credential is not asserted byte-identical to Vercel's hidden canonical secret. No secret reset is needed to prove target provenance; keep any future credential refresh separate from this migration scope.
