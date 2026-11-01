-- QA L5: capability evidence gets an explicit source. Only the run-time HeyGen
-- check path writes source='heygen_check' and eligibility requires it. Legacy rows
-- keep source NULL (allowed by the CHECK) and are closed once, below, so no
-- pre-0020 evidence can ever establish LUXIFY eligibility.
ALTER TABLE "luxify_look_capability_evidence" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "luxify_look_capability_evidence" ADD CONSTRAINT "luxify_look_capability_evidence_source_ck" CHECK ("luxify_look_capability_evidence"."source" = 'heygen_check');
--> statement-breakpoint
-- One-time close of every older open evidence row (source NULL). The 0019
-- opening guard already refuses rows observed more than 5 minutes ahead.
UPDATE "luxify_look_capability_evidence" SET "revoked_at" = now() WHERE "revoked_at" IS NULL AND "source" IS NULL;
