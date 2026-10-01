CREATE TABLE "provider_account_binding_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"application_account_id" text NOT NULL,
	"origin_scope_key" text NOT NULL,
	"verified_account_scope_id" uuid,
	"state" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "provider_binding_promotions_state_ck" CHECK ("provider_account_binding_promotions"."state" in ('verified', 'conflict', 'revoked')),
	CONSTRAINT "provider_binding_promotions_hash_ck" CHECK ("provider_account_binding_promotions"."origin_scope_key" ~ '^[a-f0-9]{64}$' and "provider_account_binding_promotions"."evidence_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "provider_binding_promotions_evidence_ref_ck" CHECK (length("provider_account_binding_promotions"."evidence_ref") between 1 and 1024 and position('://' in "provider_account_binding_promotions"."evidence_ref") = 0),
	CONSTRAINT "provider_binding_promotions_timestamps_ck" CHECK (("provider_account_binding_promotions"."state" = 'verified' and "provider_account_binding_promotions"."verified_account_scope_id" is not null and "provider_account_binding_promotions"."verified_at" is not null and "provider_account_binding_promotions"."revoked_at" is null) or ("provider_account_binding_promotions"."state" = 'conflict' and "provider_account_binding_promotions"."verified_at" is null and "provider_account_binding_promotions"."revoked_at" is null) or ("provider_account_binding_promotions"."state" = 'revoked' and "provider_account_binding_promotions"."verified_account_scope_id" is not null and "provider_account_binding_promotions"."verified_at" is not null and "provider_account_binding_promotions"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "provider_account_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_account_id" text NOT NULL,
	"provider" text DEFAULT 'heygen' NOT NULL,
	"environment" text NOT NULL,
	"project_id" text NOT NULL,
	"database_binding_sha256" text NOT NULL,
	"credential_scope_fingerprint" text NOT NULL,
	"origin_scope_key" text NOT NULL,
	"credential_evidence_digest" text,
	"credential_evidence_ref" text,
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_account_bindings_provider_ck" CHECK ("provider_account_bindings"."provider" = 'heygen'),
	CONSTRAINT "provider_account_bindings_state_ck" CHECK ("provider_account_bindings"."lifecycle_state" in ('active', 'revoked')),
	CONSTRAINT "provider_account_bindings_target_ck" CHECK (length("provider_account_bindings"."environment") between 1 and 80 and length("provider_account_bindings"."project_id") between 1 and 255),
	CONSTRAINT "provider_account_bindings_hashes_ck" CHECK ("provider_account_bindings"."database_binding_sha256" ~ '^[a-f0-9]{64}$' and "provider_account_bindings"."credential_scope_fingerprint" ~ '^[a-f0-9]{64}$' and "provider_account_bindings"."origin_scope_key" ~ '^[a-f0-9]{64}$' and ("provider_account_bindings"."credential_evidence_digest" is null or "provider_account_bindings"."credential_evidence_digest" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "provider_account_bindings_evidence_ref_ck" CHECK ("provider_account_bindings"."credential_evidence_ref" is null or (length("provider_account_bindings"."credential_evidence_ref") between 1 and 1024 and position('://' in "provider_account_bindings"."credential_evidence_ref") = 0)),
	CONSTRAINT "provider_account_bindings_revoke_ck" CHECK (("provider_account_bindings"."lifecycle_state" = 'revoked') = ("provider_account_bindings"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "provider_approval_claim_resources" (
	"claim_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"application_account_id" text NOT NULL,
	"origin_scope_key" text NOT NULL,
	"verb" text NOT NULL,
	CONSTRAINT "provider_approval_claim_resources_pk" PRIMARY KEY("claim_id","resource_id","verb"),
	CONSTRAINT "provider_approval_claim_resources_verb_ck" CHECK ("provider_approval_claim_resources"."verb" in ('read', 'delete', 'readback')),
	CONSTRAINT "provider_approval_claim_resources_scope_ck" CHECK ("provider_approval_claim_resources"."origin_scope_key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "provider_approval_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_account_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"origin_scope_key" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"plan_digest" text NOT NULL,
	"approval_kid" text NOT NULL,
	"approval_envelope_digest" text NOT NULL,
	"candidate_id" text NOT NULL,
	"source_sha256" text NOT NULL,
	"adapter_sha256" text NOT NULL,
	"target_digest" text NOT NULL,
	"cohort_id" text NOT NULL,
	"max_provider_calls" integer NOT NULL,
	"used_provider_calls" integer DEFAULT 0 NOT NULL,
	"max_spend_microusd" bigint DEFAULT 0 NOT NULL,
	"spent_microusd" bigint DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_approval_claims_hashes_ck" CHECK ("provider_approval_claims"."origin_scope_key" ~ '^[a-f0-9]{64}$' and "provider_approval_claims"."nonce_digest" ~ '^[a-f0-9]{64}$' and "provider_approval_claims"."plan_digest" ~ '^[a-f0-9]{64}$' and "provider_approval_claims"."approval_envelope_digest" ~ '^[a-f0-9]{64}$' and "provider_approval_claims"."source_sha256" ~ '^[a-f0-9]{64}$' and "provider_approval_claims"."adapter_sha256" ~ '^[a-f0-9]{64}$' and "provider_approval_claims"."target_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "provider_approval_claims_candidate_ck" CHECK ("provider_approval_claims"."candidate_id" = 'source:' || "provider_approval_claims"."source_sha256"),
	CONSTRAINT "provider_approval_claims_budget_ck" CHECK ("provider_approval_claims"."max_provider_calls" > 0 and "provider_approval_claims"."used_provider_calls" >= 0 and "provider_approval_claims"."used_provider_calls" <= "provider_approval_claims"."max_provider_calls" and "provider_approval_claims"."max_spend_microusd" >= 0 and "provider_approval_claims"."spent_microusd" >= 0 and "provider_approval_claims"."spent_microusd" <= "provider_approval_claims"."max_spend_microusd"),
	CONSTRAINT "provider_approval_claims_time_ck" CHECK ("provider_approval_claims"."expires_at" > "provider_approval_claims"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "provider_consumer_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_account_id" text NOT NULL,
	"origin_scope_key" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"consumer_kind" text NOT NULL,
	"consumer_id" text NOT NULL,
	"origin_operation_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_claimed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "provider_consumer_refs_kind_ck" CHECK ("provider_consumer_references"."consumer_kind" in ('enrollment', 'identity', 'job', 'template', 'provider_resource', 'unknown_external')),
	CONSTRAINT "provider_consumer_refs_state_ck" CHECK ("provider_consumer_references"."state" in ('active', 'pending', 'ambiguous', 'released')),
	CONSTRAINT "provider_consumer_refs_scope_ck" CHECK ("provider_consumer_references"."origin_scope_key" ~ '^[a-f0-9]{64}$' and length("provider_consumer_references"."consumer_id") between 1 and 255),
	CONSTRAINT "provider_consumer_refs_timestamps_ck" CHECK (("provider_consumer_references"."state" = 'active' and "provider_consumer_references"."release_claimed_at" is null and "provider_consumer_references"."released_at" is null) or ("provider_consumer_references"."state" = 'pending' and "provider_consumer_references"."release_claimed_at" is not null and "provider_consumer_references"."released_at" is null) or ("provider_consumer_references"."state" = 'released' and "provider_consumer_references"."release_claimed_at" is not null and "provider_consumer_references"."released_at" is not null) or ("provider_consumer_references"."state" = 'ambiguous' and "provider_consumer_references"."released_at" is null))
);
--> statement-breakpoint
CREATE TABLE "provider_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_account_id" text NOT NULL,
	"origin_scope_key" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"resource_id" uuid,
	"reference_id" uuid,
	"event_type" text NOT NULL,
	"correlation_id" text NOT NULL,
	"method" text,
	"path_template" text,
	"outcome" text,
	"observed_resource_kind" text,
	"observed_provider_resource_id" text,
	"provider_http_status" integer,
	"provider_code" text,
	"evidence_digest" text,
	"private_evidence_ref" text,
	"approved_plan_digest" text,
	"approval_nonce_digest" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_lifecycle_events_scope_ck" CHECK ("provider_lifecycle_events"."origin_scope_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "provider_lifecycle_events_method_ck" CHECK ("provider_lifecycle_events"."method" is null or "provider_lifecycle_events"."method" in ('GET', 'POST', 'DELETE')),
	CONSTRAINT "provider_lifecycle_events_outcome_ck" CHECK ("provider_lifecycle_events"."outcome" is null or "provider_lifecycle_events"."outcome" in ('PRESENT', 'DELETE_ACKNOWLEDGED', 'API_ABSENT', 'URL_DENIAL_OBSERVED')),
	CONSTRAINT "provider_lifecycle_events_resource_kind_ck" CHECK ("provider_lifecycle_events"."observed_resource_kind" is null or "provider_lifecycle_events"."observed_resource_kind" in ('asset', 'avatar_look', 'avatar_group', 'voice', 'video')),
	CONSTRAINT "provider_lifecycle_events_resource_id_ck" CHECK ("provider_lifecycle_events"."observed_provider_resource_id" is null or "provider_lifecycle_events"."observed_provider_resource_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
	CONSTRAINT "provider_lifecycle_events_http_ck" CHECK ("provider_lifecycle_events"."provider_http_status" is null or "provider_lifecycle_events"."provider_http_status" between 100 and 599),
	CONSTRAINT "provider_lifecycle_events_hashes_ck" CHECK (("provider_lifecycle_events"."evidence_digest" is null or "provider_lifecycle_events"."evidence_digest" ~ '^[a-f0-9]{64}$') and ("provider_lifecycle_events"."approved_plan_digest" is null or "provider_lifecycle_events"."approved_plan_digest" ~ '^[a-f0-9]{64}$') and ("provider_lifecycle_events"."approval_nonce_digest" is null or "provider_lifecycle_events"."approval_nonce_digest" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "provider_lifecycle_events_safe_text_ck" CHECK (length("provider_lifecycle_events"."event_type") between 1 and 120 and ("provider_lifecycle_events"."path_template" is null or (length("provider_lifecycle_events"."path_template") between 1 and 255 and left("provider_lifecycle_events"."path_template", 1) = '/' and position('://' in "provider_lifecycle_events"."path_template") = 0)) and ("provider_lifecycle_events"."provider_code" is null or "provider_lifecycle_events"."provider_code" ~ '^[A-Za-z0-9_-]{1,80}$') and ("provider_lifecycle_events"."private_evidence_ref" is null or (length("provider_lifecycle_events"."private_evidence_ref") between 1 and 1024 and position('://' in "provider_lifecycle_events"."private_evidence_ref") = 0)) and "provider_lifecycle_events"."details"::text !~* 'https?://')
);
--> statement-breakpoint
CREATE TABLE "provider_lifecycle_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_account_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"origin_scope_key" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"origin_operation_key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"correlation_id" text NOT NULL,
	"enrollment_id" uuid,
	"identity_id" uuid,
	"job_id" text,
	"request_digest" text NOT NULL,
	"source_sha256" text,
	"source_bytes" integer,
	"approval_claim_id" uuid,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_lifecycle_operations_kind_ck" CHECK ("provider_lifecycle_operations"."kind" in ('asset_upload', 'avatar_create', 'voice_clone', 'video_create', 'resource_read', 'resource_delete', 'url_probe')),
	CONSTRAINT "provider_lifecycle_operations_state_ck" CHECK ("provider_lifecycle_operations"."state" in ('reserved', 'pending', 'succeeded', 'failed', 'ambiguous')),
	CONSTRAINT "provider_lifecycle_operations_attempt_ck" CHECK ("provider_lifecycle_operations"."attempt" between 1 and 100),
	CONSTRAINT "provider_lifecycle_operations_hash_ck" CHECK ("provider_lifecycle_operations"."origin_scope_key" ~ '^[a-f0-9]{64}$' and "provider_lifecycle_operations"."request_digest" ~ '^[a-f0-9]{64}$' and ("provider_lifecycle_operations"."source_sha256" is null or "provider_lifecycle_operations"."source_sha256" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "provider_lifecycle_operations_source_ck" CHECK (("provider_lifecycle_operations"."source_sha256" is null and "provider_lifecycle_operations"."source_bytes" is null) or ("provider_lifecycle_operations"."source_sha256" is not null and "provider_lifecycle_operations"."source_bytes" > 0)),
	CONSTRAINT "provider_lifecycle_operations_time_ck" CHECK ("provider_lifecycle_operations"."completed_at" is null or "provider_lifecycle_operations"."submitted_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "provider_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_account_id" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"origin_scope_key" text NOT NULL,
	"verified_account_scope_id" uuid,
	"kind" text NOT NULL,
	"provider_resource_id" text NOT NULL,
	"origin_operation_id" uuid NOT NULL,
	"voice_namespace" text,
	"parent_resource_id" uuid,
	"state" text DEFAULT 'unknown' NOT NULL,
	"source_sha256" text,
	"source_bytes" integer,
	"public_url_digest" text,
	"private_evidence_ref" text,
	"evidence_expires_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_resources_kind_ck" CHECK ("provider_resources"."kind" in ('asset', 'avatar_look', 'avatar_group', 'voice', 'video')),
	CONSTRAINT "provider_resources_state_ck" CHECK ("provider_resources"."state" in ('unknown', 'processing', 'present', 'ready', 'failed', 'delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation')),
	CONSTRAINT "provider_resources_id_ck" CHECK ("provider_resources"."provider_resource_id" ~ '^[A-Za-z0-9_.:-]{1,255}$'),
	CONSTRAINT "provider_resources_scope_hash_ck" CHECK ("provider_resources"."origin_scope_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "provider_resources_voice_namespace_ck" CHECK (("provider_resources"."kind" = 'voice' and "provider_resources"."voice_namespace" = 'instant') or ("provider_resources"."kind" <> 'voice' and "provider_resources"."voice_namespace" is null)),
	CONSTRAINT "provider_resources_source_ck" CHECK ((("provider_resources"."source_sha256" is null and "provider_resources"."source_bytes" is null) or ("provider_resources"."source_sha256" ~ '^[a-f0-9]{64}$' and "provider_resources"."source_bytes" > 0)) and ("provider_resources"."public_url_digest" is null or "provider_resources"."public_url_digest" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "provider_resources_evidence_ref_ck" CHECK ("provider_resources"."private_evidence_ref" is null or (length("provider_resources"."private_evidence_ref") between 1 and 1024 and position('://' in "provider_resources"."private_evidence_ref") = 0))
);
--> statement-breakpoint
CREATE TABLE "provider_verified_account_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'heygen' NOT NULL,
	"provider_account_fingerprint" text NOT NULL,
	"canonical_scope_key" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_verified_account_scopes_provider_ck" CHECK ("provider_verified_account_scopes"."provider" = 'heygen'),
	CONSTRAINT "provider_verified_account_scopes_hashes_ck" CHECK ("provider_verified_account_scopes"."provider_account_fingerprint" ~ '^[a-f0-9]{64}$' and "provider_verified_account_scopes"."canonical_scope_key" ~ '^[a-f0-9]{64}$' and "provider_verified_account_scopes"."evidence_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "provider_verified_account_scopes_evidence_ref_ck" CHECK (length("provider_verified_account_scopes"."evidence_ref") between 1 and 1024 and position('://' in "provider_verified_account_scopes"."evidence_ref") = 0)
);
--> statement-breakpoint
ALTER TABLE "identity_consents" ADD COLUMN "idempotency_key" uuid;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD COLUMN "audio_extraction_authorization" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD COLUMN "temporary_public_provider_exposure_authorization" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD COLUMN "consent_purpose" text;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD COLUMN "source_video_sha256" text;--> statement-breakpoint
-- Composite foreign keys require their referenced unique indexes first.

CREATE UNIQUE INDEX "provider_account_bindings_origin_graph_uq" ON "provider_account_bindings" USING btree ("id","application_account_id","origin_scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_approval_claims_graph_uq" ON "provider_approval_claims" USING btree ("id","application_account_id","origin_scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_consumer_refs_graph_uq" ON "provider_consumer_references" USING btree ("id","application_account_id","origin_scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_lifecycle_operations_graph_uq" ON "provider_lifecycle_operations" USING btree ("id","application_account_id","origin_scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resources_graph_uq" ON "provider_resources" USING btree ("id","application_account_id","origin_scope_key");--> statement-breakpoint
ALTER TABLE "provider_account_binding_promotions" ADD CONSTRAINT "provider_account_binding_promotions_verified_account_scope_id_provider_verified_account_scopes_id_fk" FOREIGN KEY ("verified_account_scope_id") REFERENCES "public"."provider_verified_account_scopes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account_binding_promotions" ADD CONSTRAINT "provider_binding_promotions_origin_fk" FOREIGN KEY ("binding_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_account_bindings"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_account_bindings" ADD CONSTRAINT "provider_account_bindings_application_account_id_users_id_fk" FOREIGN KEY ("application_account_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_approval_claim_resources" ADD CONSTRAINT "provider_approval_claim_resources_claim_fk" FOREIGN KEY ("claim_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_approval_claims"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_approval_claim_resources" ADD CONSTRAINT "provider_approval_claim_resources_resource_fk" FOREIGN KEY ("resource_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_resources"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_approval_claims" ADD CONSTRAINT "provider_approval_claims_origin_fk" FOREIGN KEY ("binding_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_account_bindings"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_consumer_references" ADD CONSTRAINT "provider_consumer_refs_resource_fk" FOREIGN KEY ("resource_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_resources"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_consumer_references" ADD CONSTRAINT "provider_consumer_refs_operation_fk" FOREIGN KEY ("origin_operation_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_lifecycle_operations"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_events" ADD CONSTRAINT "provider_lifecycle_events_operation_fk" FOREIGN KEY ("operation_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_lifecycle_operations"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_events" ADD CONSTRAINT "provider_lifecycle_events_resource_fk" FOREIGN KEY ("resource_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_resources"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_events" ADD CONSTRAINT "provider_lifecycle_events_reference_fk" FOREIGN KEY ("reference_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_consumer_references"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" ADD CONSTRAINT "provider_lifecycle_operations_enrollment_id_identity_video_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."identity_video_enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" ADD CONSTRAINT "provider_lifecycle_operations_identity_id_user_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."user_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" ADD CONSTRAINT "provider_lifecycle_operations_job_id_video_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."video_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" ADD CONSTRAINT "provider_lifecycle_operations_origin_fk" FOREIGN KEY ("binding_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_account_bindings"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_lifecycle_operations" ADD CONSTRAINT "provider_lifecycle_operations_approval_fk" FOREIGN KEY ("approval_claim_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_approval_claims"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_resources" ADD CONSTRAINT "provider_resources_verified_account_scope_id_provider_verified_account_scopes_id_fk" FOREIGN KEY ("verified_account_scope_id") REFERENCES "public"."provider_verified_account_scopes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_resources" ADD CONSTRAINT "provider_resources_origin_binding_fk" FOREIGN KEY ("binding_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_account_bindings"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_resources" ADD CONSTRAINT "provider_resources_origin_operation_fk" FOREIGN KEY ("origin_operation_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_lifecycle_operations"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_resources" ADD CONSTRAINT "provider_resources_parent_fk" FOREIGN KEY ("parent_resource_id","application_account_id","origin_scope_key") REFERENCES "public"."provider_resources"("id","application_account_id","origin_scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_binding_promotions_active_verified_uq" ON "provider_account_binding_promotions" USING btree ("binding_id") WHERE "provider_account_binding_promotions"."state" = 'verified';--> statement-breakpoint
CREATE INDEX "provider_binding_promotions_origin_idx" ON "provider_account_binding_promotions" USING btree ("application_account_id","origin_scope_key","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_account_bindings_target_credential_uq" ON "provider_account_bindings" USING btree ("application_account_id","provider","environment","project_id","database_binding_sha256","credential_scope_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_account_bindings_active_target_uq" ON "provider_account_bindings" USING btree ("application_account_id","provider","environment","project_id","database_binding_sha256") WHERE "provider_account_bindings"."lifecycle_state" = 'active';--> statement-breakpoint
CREATE INDEX "provider_account_bindings_account_state_idx" ON "provider_account_bindings" USING btree ("application_account_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "provider_approval_claim_resources_account_idx" ON "provider_approval_claim_resources" USING btree ("application_account_id","origin_scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_approval_claims_nonce_uq" ON "provider_approval_claims" USING btree ("nonce_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_approval_claims_envelope_uq" ON "provider_approval_claims" USING btree ("approval_envelope_digest");--> statement-breakpoint
CREATE INDEX "provider_approval_claims_account_expiry_idx" ON "provider_approval_claims" USING btree ("application_account_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_consumer_refs_resource_consumer_uq" ON "provider_consumer_references" USING btree ("resource_id","consumer_kind","consumer_id");--> statement-breakpoint
CREATE INDEX "provider_consumer_refs_account_state_idx" ON "provider_consumer_references" USING btree ("application_account_id","state");--> statement-breakpoint
CREATE INDEX "provider_consumer_refs_consumer_idx" ON "provider_consumer_references" USING btree ("consumer_kind","consumer_id");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_events_operation_observed_idx" ON "provider_lifecycle_events" USING btree ("operation_id","observed_at");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_events_resource_observed_idx" ON "provider_lifecycle_events" USING btree ("resource_id","observed_at");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_events_account_observed_idx" ON "provider_lifecycle_events" USING btree ("application_account_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_lifecycle_operations_origin_attempt_uq" ON "provider_lifecycle_operations" USING btree ("origin_scope_key","kind","origin_operation_key","attempt");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_operations_account_state_idx" ON "provider_lifecycle_operations" USING btree ("application_account_id","state","created_at");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_operations_enrollment_idx" ON "provider_lifecycle_operations" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_operations_identity_idx" ON "provider_lifecycle_operations" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "provider_lifecycle_operations_job_idx" ON "provider_lifecycle_operations" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resources_origin_scope_resource_uq" ON "provider_resources" USING btree ("origin_scope_key","kind","provider_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_resources_verified_scope_resource_uq" ON "provider_resources" USING btree ("verified_account_scope_id","kind","provider_resource_id") WHERE "provider_resources"."verified_account_scope_id" is not null;--> statement-breakpoint
CREATE INDEX "provider_resources_account_state_idx" ON "provider_resources" USING btree ("application_account_id","kind","state");--> statement-breakpoint
CREATE INDEX "provider_resources_origin_operation_idx" ON "provider_resources" USING btree ("origin_operation_id");--> statement-breakpoint
CREATE INDEX "provider_resources_parent_idx" ON "provider_resources" USING btree ("parent_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_verified_account_scopes_provider_account_uq" ON "provider_verified_account_scopes" USING btree ("provider","provider_account_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_verified_account_scopes_canonical_key_uq" ON "provider_verified_account_scopes" USING btree ("canonical_scope_key");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_consents_account_idempotency_uq" ON "identity_consents" USING btree ("account_id","idempotency_key") WHERE "identity_consents"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "identity_consents" ADD CONSTRAINT "identity_consents_source_video_hash_ck" CHECK ("identity_consents"."source_video_sha256" is null or "identity_consents"."source_video_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "identity_consents" ADD CONSTRAINT "identity_consents_bridge_v2_ck" CHECK ("identity_consents"."policy_version" <> 'identity-provider-bridge-v2' or ("identity_consents"."audio_extraction_authorization" and "identity_consents"."temporary_public_provider_exposure_authorization" and "identity_consents"."source_video_sha256" is not null and "identity_consents"."consent_purpose" is not null and "identity_consents"."consent_purpose" = 'identity-voice-enrollment'));
--> statement-breakpoint

-- Provider lifecycle guard plan (reviewed narrow MVP foundation):
-- 1. Require the canonical account-scoped transaction advisory lock before any
--    mutation of an account-owned provider ledger row.
-- 2. Keep target, origin, request, source, approval scope, and ownership facts
--    immutable; permit only explicit forward lifecycle transitions.
-- 3. Keep verified account evidence, lifecycle events, and approval-resource
--    scope append-only. Other ledger rows may transition but are never deleted.
-- 4. Permit a resource's verified scope only as a one-time annotation from the
--    binding's exact active promotion. Cross-credential rotation remains held.
-- 5. Reject unsafe parent/reference/claim graphs and enforce tombstones before
--    a provider delete operation can become pending. Provider HTTP stays
--    outside database transactions.

CREATE OR REPLACE FUNCTION public.provider_lifecycle_guard_key(p_account_id text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_octets integer;
BEGIN
  v_octets := pg_catalog.octet_length(p_account_id);
  IF v_octets < 1 OR v_octets > 512 THEN
    RAISE EXCEPTION 'provider lifecycle account is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- PostgreSQL text cannot contain the zero code point. Match the application
  -- helper for the remaining forbidden ASCII controls without constructing it.
  IF pg_catalog.strpos(p_account_id, pg_catalog.chr(127)) > 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.generate_series(1, 31) AS control_code(code)
       WHERE pg_catalog.strpos(p_account_id, pg_catalog.chr(control_code.code)) > 0
     ) THEN
    RAISE EXCEPTION 'provider lifecycle account is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.hashtextextended(
    'provider-lifecycle-v1:' || v_octets::text || ':' || p_account_id,
    0
  );
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_lifecycle_assert_account_guard(p_account_id text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_key bigint;
  v_held boolean;
BEGIN
  v_key := public.provider_lifecycle_guard_key(p_account_id);
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_locks AS held
    WHERE held.locktype = 'advisory'
      AND held.pid = pg_catalog.pg_backend_pid()
      AND held.granted
      AND held.mode = 'ExclusiveLock'
      AND held.classid::bigint = ((v_key >> 32) & 4294967295::bigint)
      AND held.objid::bigint = (v_key & 4294967295::bigint)
      AND held.objsubid = 1
  ) INTO v_held;

  IF NOT v_held THEN
    RAISE EXCEPTION 'provider lifecycle account guard must be acquired before ledger mutation'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_lifecycle_internal_ref_is_safe(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.octet_length(p_value) BETWEEN 1 AND 1024
    AND p_value ~ '^[A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)+$'
    AND p_value !~ '(^|/)[.]{1,2}(/|$)'
    AND pg_catalog.strpos(p_value, '//') = 0
    AND p_value !~ '/$';
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_approval_target_is_active(p_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.provider_approval_claims AS claim
    JOIN public.provider_account_bindings AS binding
      ON binding.id = claim.binding_id
     AND binding.application_account_id = claim.application_account_id
     AND binding.origin_scope_key = claim.origin_scope_key
     AND binding.lifecycle_state = 'active'
    JOIN public.provider_account_binding_promotions AS promotion
      ON promotion.binding_id = claim.binding_id
     AND promotion.application_account_id = claim.application_account_id
     AND promotion.origin_scope_key = claim.origin_scope_key
     AND promotion.state = 'verified'
    WHERE claim.id = p_claim_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.provider_approval_claim_resources AS scope
        JOIN public.provider_resources AS resource ON resource.id = scope.resource_id
        WHERE scope.claim_id = claim.id
          AND resource.verified_account_scope_id IS DISTINCT FROM promotion.verified_account_scope_id
      )
  );
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_account_bindings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.provider_lifecycle_assert_account_guard(OLD.application_account_id);
    RAISE EXCEPTION 'provider account bindings cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.application_account_id ELSE OLD.application_account_id END
  );

  IF (NEW.credential_evidence_digest IS NULL) <> (NEW.credential_evidence_ref IS NULL) THEN
    RAISE EXCEPTION 'provider binding credential evidence must be complete'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.credential_evidence_ref IS NOT NULL
     AND NOT public.provider_lifecycle_internal_ref_is_safe(NEW.credential_evidence_ref) THEN
    RAISE EXCEPTION 'provider binding credential evidence reference is not an internal path'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_state <> 'active' OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider binding must be inserted active'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.updated_at < NEW.created_at THEN
      RAISE EXCEPTION 'provider binding timestamps cannot move backward'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.application_account_id IS DISTINCT FROM OLD.application_account_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.database_binding_sha256 IS DISTINCT FROM OLD.database_binding_sha256
     OR NEW.credential_scope_fingerprint IS DISTINCT FROM OLD.credential_scope_fingerprint
     OR NEW.origin_scope_key IS DISTINCT FROM OLD.origin_scope_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provider binding origin and target facts are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.credential_evidence_digest IS NOT NULL
     AND (NEW.credential_evidence_digest IS DISTINCT FROM OLD.credential_evidence_digest
          OR NEW.credential_evidence_ref IS DISTINCT FROM OLD.credential_evidence_ref) THEN
    RAISE EXCEPTION 'provider binding credential evidence is immutable once recorded'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.credential_evidence_digest IS NULL
     AND NEW.credential_evidence_digest IS NULL
     AND NEW.credential_evidence_ref IS DISTINCT FROM OLD.credential_evidence_ref THEN
    RAISE EXCEPTION 'provider binding credential evidence cannot be partially changed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
     AND NOT (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'revoked') THEN
    RAISE EXCEPTION 'provider binding lifecycle transition is not allowed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'provider binding revocation timestamp is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND NEW.revoked_at < NEW.created_at THEN
    RAISE EXCEPTION 'provider binding revocation cannot predate the binding'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at OR NEW.updated_at < NEW.created_at THEN
    RAISE EXCEPTION 'provider binding timestamps cannot move backward'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_account_bindings_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_account_bindings
FOR EACH ROW EXECUTE FUNCTION public.provider_account_bindings_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_verified_account_scopes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'provider verified account scopes are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NOT public.provider_lifecycle_internal_ref_is_safe(NEW.evidence_ref) THEN
    RAISE EXCEPTION 'provider verified account scope evidence reference is not an internal path'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_verified_account_scopes_append_only_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_verified_account_scopes
FOR EACH ROW EXECUTE FUNCTION public.provider_verified_account_scopes_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_binding_promotions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_binding_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.provider_lifecycle_assert_account_guard(OLD.application_account_id);
    RAISE EXCEPTION 'provider binding promotions cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.application_account_id ELSE OLD.application_account_id END
  );

  SELECT lifecycle_state
  INTO v_binding_state
  FROM public.provider_account_bindings
  WHERE id = NEW.binding_id
    AND application_account_id = NEW.application_account_id
    AND origin_scope_key = NEW.origin_scope_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider promotion binding graph is invalid'
      USING ERRCODE = '23503';
  END IF;
  IF NOT public.provider_lifecycle_internal_ref_is_safe(NEW.evidence_ref) THEN
    RAISE EXCEPTION 'provider promotion evidence reference is not an internal path'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state = 'revoked' THEN
      RAISE EXCEPTION 'provider promotion cannot be inserted revoked'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'verified' AND v_binding_state <> 'active' THEN
      RAISE EXCEPTION 'only an active provider binding can be promoted'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.verified_at IS NOT NULL AND NEW.verified_at < NEW.observed_at THEN
      RAISE EXCEPTION 'provider promotion verification cannot predate observation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.application_account_id IS DISTINCT FROM OLD.application_account_id
     OR NEW.origin_scope_key IS DISTINCT FROM OLD.origin_scope_key
     OR NEW.verified_account_scope_id IS DISTINCT FROM OLD.verified_account_scope_id
     OR NEW.evidence_digest IS DISTINCT FROM OLD.evidence_digest
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'provider promotion evidence and origin are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (OLD.state = 'verified' AND NEW.state = 'revoked') THEN
    RAISE EXCEPTION 'provider promotion lifecycle transition is not allowed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'provider promotion revocation timestamp is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.verified_at IS NOT NULL AND NEW.verified_at < NEW.observed_at THEN
    RAISE EXCEPTION 'provider promotion verification cannot predate observation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND NEW.revoked_at < NEW.verified_at THEN
    RAISE EXCEPTION 'provider promotion revocation cannot predate verification'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_binding_promotions_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_account_binding_promotions
FOR EACH ROW EXECUTE FUNCTION public.provider_binding_promotions_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_verified_promotion_complete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state text;
  v_scope_id uuid;
  v_binding_id uuid;
BEGIN
  SELECT state, verified_account_scope_id, binding_id
  INTO v_state, v_scope_id, v_binding_id
  FROM public.provider_account_binding_promotions
  WHERE id = NEW.id;

  IF v_state = 'verified' AND EXISTS (
    SELECT 1
    FROM public.provider_resources
    WHERE binding_id = v_binding_id
      AND verified_account_scope_id IS DISTINCT FROM v_scope_id
  ) THEN
    RAISE EXCEPTION 'verified provider promotion must annotate every binding resource atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER provider_verified_promotion_complete_trg
AFTER INSERT ON public.provider_account_binding_promotions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.provider_verified_promotion_complete_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_approval_claims_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_binding_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.provider_lifecycle_assert_account_guard(OLD.application_account_id);
    RAISE EXCEPTION 'provider approval claims cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.application_account_id ELSE OLD.application_account_id END
  );

  IF NEW.max_provider_calls > 10000
     OR NEW.max_spend_microusd > 9007199254740991::bigint
     OR NEW.spent_microusd > 9007199254740991::bigint THEN
    RAISE EXCEPTION 'provider approval budgets must be safe integers within policy bounds'
      USING ERRCODE = '22003';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'provider approval claims must be inserted fresh'
        USING ERRCODE = '23514';
    END IF;
    SELECT lifecycle_state
    INTO v_binding_state
    FROM public.provider_account_bindings
    WHERE id = NEW.binding_id
      AND application_account_id = NEW.application_account_id
      AND origin_scope_key = NEW.origin_scope_key
    FOR UPDATE;
    IF NOT FOUND OR v_binding_state <> 'active' THEN
      RAISE EXCEPTION 'provider approval target binding is not active'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.provider_account_binding_promotions
      WHERE binding_id = NEW.binding_id
        AND application_account_id = NEW.application_account_id
        AND origin_scope_key = NEW.origin_scope_key
        AND state = 'verified'
    ) THEN
      RAISE EXCEPTION 'provider approval requires an active verified promotion'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.application_account_id IS DISTINCT FROM OLD.application_account_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.origin_scope_key IS DISTINCT FROM OLD.origin_scope_key
     OR NEW.nonce_digest IS DISTINCT FROM OLD.nonce_digest
     OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest
     OR NEW.approval_kid IS DISTINCT FROM OLD.approval_kid
     OR NEW.approval_envelope_digest IS DISTINCT FROM OLD.approval_envelope_digest
     OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
     OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
     OR NEW.adapter_sha256 IS DISTINCT FROM OLD.adapter_sha256
     OR NEW.target_digest IS DISTINCT FROM OLD.target_digest
     OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
     OR NEW.max_provider_calls IS DISTINCT FROM OLD.max_provider_calls
     OR NEW.max_spend_microusd IS DISTINCT FROM OLD.max_spend_microusd
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'provider approval identity, target, scope, and maximum budgets are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.used_provider_calls < OLD.used_provider_calls
     OR NEW.spent_microusd < OLD.spent_microusd THEN
    RAISE EXCEPTION 'provider approval budget usage cannot decrease'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'provider approval consumption timestamp is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'provider approval revocation timestamp is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked provider approval cannot be consumed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'a revoked or expired provider approval cannot be consumed'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.provider_approval_claim_resources
      WHERE claim_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'provider approval scope must be recorded before consumption'
        USING ERRCODE = '23514';
    END IF;
    IF NOT public.provider_approval_target_is_active(NEW.id) THEN
      RAISE EXCEPTION 'provider approval target verification is no longer active'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.consumed_at IS NOT NULL
     AND (NEW.consumed_at < NEW.issued_at OR NEW.consumed_at > NEW.expires_at) THEN
    RAISE EXCEPTION 'provider approval consumption timestamp is outside its signed lifetime'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND NEW.revoked_at < NEW.issued_at THEN
    RAISE EXCEPTION 'provider approval revocation cannot predate issuance'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.used_provider_calls > OLD.used_provider_calls
      OR NEW.spent_microusd > OLD.spent_microusd)
     AND (NEW.consumed_at IS NULL OR NEW.revoked_at IS NOT NULL
          OR NEW.expires_at <= statement_timestamp()) THEN
    RAISE EXCEPTION 'provider approval budget can be consumed only by an active unexpired claim'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.used_provider_calls > OLD.used_provider_calls
      OR NEW.spent_microusd > OLD.spent_microusd)
     AND NOT public.provider_approval_target_is_active(NEW.id) THEN
    RAISE EXCEPTION 'provider approval budget cannot advance after target verification is revoked'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND NEW.consumed_at > statement_timestamp() THEN
    RAISE EXCEPTION 'provider approval consumption timestamp cannot be in the future'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_approval_claims_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_approval_claims
FOR EACH ROW EXECUTE FUNCTION public.provider_approval_claims_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_lifecycle_operations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_local_account text;
  v_claim record;
  v_required_verb text;
  v_scope_count integer;
  v_unclaimed_count integer;
  v_nonreserved_attempts integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.provider_lifecycle_assert_account_guard(OLD.application_account_id);
    RAISE EXCEPTION 'provider lifecycle operations cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.application_account_id ELSE OLD.application_account_id END
  );

  IF (NEW.source_sha256 IS NULL) <> (NEW.source_bytes IS NULL)
     OR (NEW.source_bytes IS NOT NULL AND NEW.source_bytes <= 0) THEN
    RAISE EXCEPTION 'provider operation source digest and byte count must be a complete positive pair'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.application_account_id IS DISTINCT FROM OLD.application_account_id
    OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
    OR NEW.origin_scope_key IS DISTINCT FROM OLD.origin_scope_key
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.origin_operation_key IS DISTINCT FROM OLD.origin_operation_key
    OR NEW.attempt IS DISTINCT FROM OLD.attempt
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id
    OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
    OR NEW.source_bytes IS DISTINCT FROM OLD.source_bytes
    OR NEW.approval_claim_id IS DISTINCT FROM OLD.approval_claim_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'provider operation origin, request, source, approval, and local targets are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.enrollment_id IS NOT NULL THEN
    SELECT account_id INTO v_local_account
    FROM public.identity_video_enrollments WHERE id = NEW.enrollment_id;
    IF NOT FOUND OR v_local_account <> NEW.application_account_id THEN
      RAISE EXCEPTION 'provider operation enrollment belongs to another account'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.identity_id IS NOT NULL THEN
    SELECT account_id INTO v_local_account
    FROM public.user_identities WHERE id = NEW.identity_id;
    IF NOT FOUND OR v_local_account <> NEW.application_account_id THEN
      RAISE EXCEPTION 'provider operation identity belongs to another account'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.job_id IS NOT NULL THEN
    SELECT account_id INTO v_local_account
    FROM public.video_jobs WHERE id = NEW.job_id;
    IF NOT FOUND OR v_local_account <> NEW.application_account_id THEN
      RAISE EXCEPTION 'provider operation job belongs to another account'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.approval_claim_id IS NOT NULL THEN
    SELECT binding_id, application_account_id, origin_scope_key, source_sha256,
           consumed_at, revoked_at, expires_at, used_provider_calls
    INTO v_claim
    FROM public.provider_approval_claims
    WHERE id = NEW.approval_claim_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_claim.binding_id <> NEW.binding_id
       OR v_claim.application_account_id <> NEW.application_account_id
       OR v_claim.origin_scope_key <> NEW.origin_scope_key
       OR (NEW.source_sha256 IS NOT NULL AND v_claim.source_sha256 <> NEW.source_sha256) THEN
      RAISE EXCEPTION 'provider operation approval graph is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind IN ('resource_read', 'resource_delete', 'url_probe') THEN
    RAISE EXCEPTION 'provider reconciliation operations require an exact approval claim'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'reserved' AND NEW.state IN ('pending', 'failed'))
      OR (OLD.state = 'pending' AND NEW.state IN ('succeeded', 'failed', 'ambiguous'))
    ) THEN
      RAISE EXCEPTION 'provider operation lifecycle transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'provider operation submission timestamp is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'provider operation completion timestamp is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'provider operation timestamps cannot move backward'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.state <> 'reserved' THEN
    RAISE EXCEPTION 'provider operation must be inserted reserved before remote work'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'reserved' AND (NEW.submitted_at IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'reserved provider operation cannot have submission or completion timestamps'
      USING ERRCODE = '23514';
  ELSIF NEW.state = 'pending' AND (NEW.submitted_at IS NULL OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pending provider operation requires only a submission timestamp'
      USING ERRCODE = '23514';
  ELSIF NEW.state IN ('succeeded', 'failed', 'ambiguous')
        AND (NEW.submitted_at IS NULL OR NEW.completed_at IS NULL) THEN
    RAISE EXCEPTION 'terminal provider operation requires submission and completion timestamps'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < NEW.created_at
     OR (NEW.submitted_at IS NOT NULL AND NEW.submitted_at < NEW.created_at)
     OR (NEW.completed_at IS NOT NULL AND NEW.completed_at < NEW.submitted_at) THEN
    RAISE EXCEPTION 'provider operation timestamps cannot move backward'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'pending' AND NEW.kind IN ('resource_read', 'resource_delete', 'url_probe') THEN
    IF v_claim.consumed_at IS NULL OR v_claim.revoked_at IS NOT NULL
       OR v_claim.expires_at <= statement_timestamp() THEN
      RAISE EXCEPTION 'pending provider operation requires an active consumed approval'
        USING ERRCODE = '23514';
    END IF;
    IF NOT public.provider_approval_target_is_active(NEW.approval_claim_id) THEN
      RAISE EXCEPTION 'pending provider operation requires an active verified target'
        USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::integer
    INTO v_nonreserved_attempts
    FROM public.provider_lifecycle_operations
    WHERE approval_claim_id = NEW.approval_claim_id
      AND id <> NEW.id
      AND kind IN ('resource_read', 'resource_delete', 'url_probe')
      AND state <> 'reserved';
    IF v_claim.used_provider_calls < v_nonreserved_attempts + 1 THEN
      RAISE EXCEPTION 'pending provider operation exceeds its reserved provider-call budget'
        USING ERRCODE = '23514';
    END IF;
    v_required_verb := CASE NEW.kind
      WHEN 'resource_read' THEN 'read'
      WHEN 'resource_delete' THEN 'delete'
      ELSE 'readback'
    END;
    SELECT count(*)::integer INTO v_scope_count
    FROM public.provider_approval_claim_resources
    WHERE claim_id = NEW.approval_claim_id AND verb = v_required_verb;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'pending provider operation has no approved resource scope'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.kind = 'resource_delete' THEN
      SELECT count(*)::integer INTO v_unclaimed_count
      FROM public.provider_approval_claim_resources AS scope
      JOIN public.provider_resources AS resource ON resource.id = scope.resource_id
      WHERE scope.claim_id = NEW.approval_claim_id
        AND scope.verb = 'delete'
        AND (resource.state <> 'delete_claimed' OR resource.tombstoned_at IS NULL);
      IF v_unclaimed_count <> 0 THEN
        RAISE EXCEPTION 'pending delete operation requires every approved resource to be tombstoned and delete-claimed'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_lifecycle_operations_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION public.provider_lifecycle_operations_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_resources_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_promoted_scope uuid;
  v_origin record;
  v_parent record;
  v_expected_kind text;
  v_requires_promotion boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.provider_lifecycle_assert_account_guard(OLD.application_account_id);
    RAISE EXCEPTION 'provider resources cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.application_account_id ELSE OLD.application_account_id END
  );

  IF (NEW.source_sha256 IS NULL) <> (NEW.source_bytes IS NULL)
     OR (NEW.source_bytes IS NOT NULL AND NEW.source_bytes <= 0) THEN
    RAISE EXCEPTION 'provider resource source digest and byte count must be a complete positive pair'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.kind = 'voice' AND NEW.voice_namespace IS DISTINCT FROM 'instant')
     OR (NEW.kind <> 'voice' AND NEW.voice_namespace IS NOT NULL) THEN
    RAISE EXCEPTION 'provider voice namespace must be exactly instant and only voices may set it'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.public_url_digest IS NOT NULL
     AND (NEW.private_evidence_ref IS NULL OR NEW.evidence_expires_at IS NULL) THEN
    RAISE EXCEPTION 'provider public URL evidence requires a private evidence reference and retention deadline'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.evidence_expires_at IS NOT NULL AND NEW.private_evidence_ref IS NULL THEN
    RAISE EXCEPTION 'provider evidence retention deadline requires a private evidence reference'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.private_evidence_ref IS NOT NULL
     AND NOT public.provider_lifecycle_internal_ref_is_safe(NEW.private_evidence_ref) THEN
    RAISE EXCEPTION 'provider resource evidence reference is not an internal path'
      USING ERRCODE = '23514';
  END IF;

  SELECT verified_account_scope_id
  INTO v_promoted_scope
  FROM public.provider_account_binding_promotions
  WHERE binding_id = NEW.binding_id
    AND application_account_id = NEW.application_account_id
    AND origin_scope_key = NEW.origin_scope_key
    AND state = 'verified';

  -- A historical verified annotation survives promotion revocation so cleanup
  -- can still reconcile the exact resource. Only an insert or the one-time
  -- NULL-to-scope annotation depends on a currently active promotion.
  v_requires_promotion := TG_OP = 'INSERT';
  IF TG_OP = 'UPDATE' THEN
    v_requires_promotion := OLD.verified_account_scope_id IS NULL;
  END IF;
  IF v_requires_promotion THEN
    IF v_promoted_scope IS NULL THEN
      IF NEW.verified_account_scope_id IS NOT NULL THEN
        RAISE EXCEPTION 'provider resource verified scope requires an exact active promotion'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.verified_account_scope_id IS DISTINCT FROM v_promoted_scope THEN
      RAISE EXCEPTION 'provider resource must use the binding active verified scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT binding_id, application_account_id, origin_scope_key, kind, state
  INTO v_origin
  FROM public.provider_lifecycle_operations
  WHERE id = NEW.origin_operation_id;
  IF NOT FOUND
     OR v_origin.binding_id <> NEW.binding_id
     OR v_origin.application_account_id <> NEW.application_account_id
     OR v_origin.origin_scope_key <> NEW.origin_scope_key THEN
    RAISE EXCEPTION 'provider resource origin operation graph is invalid'
      USING ERRCODE = '23514';
  END IF;
  v_expected_kind := CASE NEW.kind
    WHEN 'asset' THEN 'asset_upload'
    WHEN 'avatar_look' THEN 'avatar_create'
    WHEN 'avatar_group' THEN 'avatar_create'
    WHEN 'voice' THEN 'voice_clone'
    WHEN 'video' THEN 'video_create'
  END;
  IF v_origin.kind <> v_expected_kind OR v_origin.state NOT IN ('pending', 'succeeded', 'ambiguous') THEN
    RAISE EXCEPTION 'provider resource kind does not match a viable origin operation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.kind = 'avatar_look' THEN
    IF NEW.parent_resource_id IS NULL THEN
      RAISE EXCEPTION 'provider avatar look requires its parent group'
        USING ERRCODE = '23514';
    END IF;
    SELECT kind, binding_id, application_account_id, origin_scope_key,
           verified_account_scope_id
    INTO v_parent
    FROM public.provider_resources
    WHERE id = NEW.parent_resource_id;
    IF NOT FOUND OR v_parent.kind <> 'avatar_group'
       OR v_parent.binding_id <> NEW.binding_id
       OR v_parent.application_account_id <> NEW.application_account_id
       OR v_parent.origin_scope_key <> NEW.origin_scope_key
       OR (v_parent.verified_account_scope_id IS NOT NULL
           AND NEW.verified_account_scope_id IS NOT NULL
           AND v_parent.verified_account_scope_id IS DISTINCT FROM NEW.verified_account_scope_id) THEN
      RAISE EXCEPTION 'provider avatar look parent must be a group in the same immutable graph'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.parent_resource_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a provider avatar look may have a parent resource'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.application_account_id IS DISTINCT FROM OLD.application_account_id
       OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
       OR NEW.origin_scope_key IS DISTINCT FROM OLD.origin_scope_key
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.provider_resource_id IS DISTINCT FROM OLD.provider_resource_id
       OR NEW.origin_operation_id IS DISTINCT FROM OLD.origin_operation_id
       OR NEW.voice_namespace IS DISTINCT FROM OLD.voice_namespace
       OR NEW.parent_resource_id IS DISTINCT FROM OLD.parent_resource_id
       OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
       OR NEW.source_bytes IS DISTINCT FROM OLD.source_bytes
       OR NEW.public_url_digest IS DISTINCT FROM OLD.public_url_digest
       OR NEW.private_evidence_ref IS DISTINCT FROM OLD.private_evidence_ref
       OR NEW.evidence_expires_at IS DISTINCT FROM OLD.evidence_expires_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'provider resource origin, identity, source, and evidence facts are immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.verified_account_scope_id IS NOT NULL
       AND NEW.verified_account_scope_id IS DISTINCT FROM OLD.verified_account_scope_id THEN
      RAISE EXCEPTION 'provider resource verified scope cannot be cleared or changed'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.tombstoned_at IS NOT NULL
       AND NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at THEN
      RAISE EXCEPTION 'provider resource tombstone is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'provider resource timestamps cannot move backward'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'unknown' AND NEW.state IN ('processing', 'present', 'ready', 'failed', 'pending_reconciliation'))
      OR (OLD.state = 'processing' AND NEW.state IN ('present', 'ready', 'failed', 'pending_reconciliation'))
      OR (OLD.state = 'present' AND NEW.state IN ('ready', 'delete_claimed', 'pending_reconciliation', 'api_absent'))
      OR (OLD.state = 'ready' AND NEW.state IN ('delete_claimed', 'pending_reconciliation', 'api_absent'))
      OR (OLD.state = 'failed' AND NEW.state IN ('delete_claimed', 'pending_reconciliation', 'api_absent'))
      OR (OLD.state = 'pending_reconciliation' AND NEW.state IN ('processing', 'present', 'ready', 'failed', 'delete_claimed', 'delete_acknowledged', 'api_absent'))
      OR (OLD.state = 'delete_claimed' AND NEW.state IN ('delete_acknowledged', 'api_absent', 'pending_reconciliation'))
      OR (OLD.state = 'delete_acknowledged' AND NEW.state IN ('api_absent', 'pending_reconciliation'))
    ) THEN
      RAISE EXCEPTION 'provider resource lifecycle transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.tombstoned_at IS NOT NULL
     AND NEW.state NOT IN ('delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation') THEN
    RAISE EXCEPTION 'provider resource tombstone requires a deletion lifecycle state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('delete_claimed', 'delete_acknowledged', 'api_absent')
     AND NEW.tombstoned_at IS NULL THEN
    RAISE EXCEPTION 'provider resource deletion state requires a tombstone'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'provider resource cannot be inserted tombstoned'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.updated_at < NEW.created_at
     OR (NEW.tombstoned_at IS NOT NULL AND NEW.tombstoned_at < NEW.created_at) THEN
    RAISE EXCEPTION 'provider resource timestamps cannot move backward'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.tombstoned_at IS NULL
     AND NEW.tombstoned_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.provider_consumer_references
      WHERE resource_id = NEW.id
        AND state <> 'released'
    ) THEN
      RAISE EXCEPTION 'provider resource with an unreleased consumer cannot be tombstoned'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.provider_approval_claim_resources AS scope
      JOIN public.provider_approval_claims AS claim ON claim.id = scope.claim_id
      JOIN public.provider_lifecycle_operations AS operation
        ON operation.approval_claim_id = claim.id
       AND operation.kind = 'resource_delete'
       AND operation.state IN ('reserved', 'pending')
      WHERE scope.resource_id = NEW.id
        AND scope.verb = 'delete'
        AND scope.application_account_id = NEW.application_account_id
        AND scope.origin_scope_key = NEW.origin_scope_key
        AND claim.binding_id = NEW.binding_id
        AND claim.consumed_at IS NOT NULL
        AND claim.revoked_at IS NULL
        AND claim.expires_at > statement_timestamp()
    ) THEN
      RAISE EXCEPTION 'provider resource delete claim requires an active consumed exact-resource approval'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_resources_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_resources
FOR EACH ROW EXECUTE FUNCTION public.provider_resources_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_resource_parent_graph_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row record;
  v_parent record;
BEGIN
  SELECT kind, binding_id, application_account_id, origin_scope_key,
         verified_account_scope_id, parent_resource_id
  INTO v_row
  FROM public.provider_resources
  WHERE id = NEW.id;
  IF NOT FOUND OR v_row.kind <> 'avatar_look' THEN
    RETURN NULL;
  END IF;

  SELECT kind, binding_id, application_account_id, origin_scope_key,
         verified_account_scope_id
  INTO v_parent
  FROM public.provider_resources
  WHERE id = v_row.parent_resource_id;
  IF NOT FOUND OR v_parent.kind <> 'avatar_group'
     OR v_parent.binding_id <> v_row.binding_id
     OR v_parent.application_account_id <> v_row.application_account_id
     OR v_parent.origin_scope_key <> v_row.origin_scope_key
     OR v_parent.verified_account_scope_id IS DISTINCT FROM v_row.verified_account_scope_id THEN
    RAISE EXCEPTION 'provider avatar look and parent group must commit in the same verified graph'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER provider_resource_parent_graph_trg
AFTER INSERT OR UPDATE ON public.provider_resources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.provider_resource_parent_graph_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_consumer_references_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_resource record;
  v_operation_binding uuid;
  v_consumer_account text;
  v_consumer_resource record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.provider_lifecycle_assert_account_guard(OLD.application_account_id);
    RAISE EXCEPTION 'provider consumer references cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(
    CASE WHEN TG_OP = 'INSERT' THEN NEW.application_account_id ELSE OLD.application_account_id END
  );

  SELECT binding_id, application_account_id, origin_scope_key,
         verified_account_scope_id, state, tombstoned_at
  INTO v_resource
  FROM public.provider_resources
  WHERE id = NEW.resource_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_resource.application_account_id <> NEW.application_account_id
     OR v_resource.origin_scope_key <> NEW.origin_scope_key THEN
    RAISE EXCEPTION 'provider consumer reference resource graph is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT binding_id INTO v_operation_binding
  FROM public.provider_lifecycle_operations
  WHERE id = NEW.origin_operation_id
    AND application_account_id = NEW.application_account_id
    AND origin_scope_key = NEW.origin_scope_key;
  IF NOT FOUND OR v_operation_binding <> v_resource.binding_id THEN
    RAISE EXCEPTION 'provider consumer reference operation graph is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND (
    v_resource.tombstoned_at IS NOT NULL
    OR v_resource.state IN ('delete_claimed', 'delete_acknowledged', 'api_absent', 'pending_reconciliation')
  ) THEN
    RAISE EXCEPTION 'provider consumer cannot attach to a tombstoned or uncertain resource'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.consumer_kind = 'enrollment' THEN
    SELECT account_id INTO v_consumer_account
    FROM public.identity_video_enrollments
    WHERE id::text = NEW.consumer_id;
    IF NOT FOUND OR v_consumer_account <> NEW.application_account_id THEN
      RAISE EXCEPTION 'provider enrollment consumer belongs to another account or does not exist'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.consumer_kind = 'identity' THEN
    SELECT account_id INTO v_consumer_account
    FROM public.user_identities
    WHERE id::text = NEW.consumer_id;
    IF NOT FOUND OR v_consumer_account <> NEW.application_account_id THEN
      RAISE EXCEPTION 'provider identity consumer belongs to another account or does not exist'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.consumer_kind = 'job' THEN
    SELECT account_id INTO v_consumer_account
    FROM public.video_jobs
    WHERE id = NEW.consumer_id;
    IF NOT FOUND OR v_consumer_account <> NEW.application_account_id THEN
      RAISE EXCEPTION 'provider job consumer belongs to another account or does not exist'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.consumer_kind = 'provider_resource' THEN
    SELECT application_account_id, binding_id, origin_scope_key,
           verified_account_scope_id
    INTO v_consumer_resource
    FROM public.provider_resources
    WHERE id::text = NEW.consumer_id;
    IF NOT FOUND
       OR v_consumer_resource.application_account_id <> NEW.application_account_id
       OR v_consumer_resource.binding_id <> v_resource.binding_id
       OR v_consumer_resource.origin_scope_key <> NEW.origin_scope_key
       OR v_consumer_resource.verified_account_scope_id IS DISTINCT FROM v_resource.verified_account_scope_id THEN
      RAISE EXCEPTION 'provider resource consumer is outside the immutable resource graph'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.application_account_id IS DISTINCT FROM OLD.application_account_id
       OR NEW.origin_scope_key IS DISTINCT FROM OLD.origin_scope_key
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
       OR NEW.consumer_kind IS DISTINCT FROM OLD.consumer_kind
       OR NEW.consumer_id IS DISTINCT FROM OLD.consumer_id
       OR NEW.origin_operation_id IS DISTINCT FROM OLD.origin_operation_id
       OR NEW.attached_at IS DISTINCT FROM OLD.attached_at THEN
      RAISE EXCEPTION 'provider consumer attachment identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.release_claimed_at IS NOT NULL
       AND NEW.release_claimed_at IS DISTINCT FROM OLD.release_claimed_at THEN
      RAISE EXCEPTION 'provider consumer release-claim timestamp is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
      RAISE EXCEPTION 'provider consumer released timestamp is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'active' AND NEW.state IN ('pending', 'ambiguous'))
      OR (OLD.state = 'pending' AND NEW.state IN ('ambiguous', 'released'))
      OR (OLD.state = 'ambiguous' AND NEW.state = 'released')
    ) THEN
      RAISE EXCEPTION 'provider consumer reference transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.release_claimed_at IS NOT NULL AND NEW.release_claimed_at < NEW.attached_at THEN
    RAISE EXCEPTION 'provider consumer release claim cannot predate attachment'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.released_at IS NOT NULL
     AND (NEW.release_claimed_at IS NULL OR NEW.released_at < NEW.release_claimed_at) THEN
    RAISE EXCEPTION 'provider consumer release cannot predate its claim'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_consumer_references_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_consumer_references
FOR EACH ROW EXECUTE FUNCTION public.provider_consumer_references_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_lifecycle_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_operation_binding uuid;
  v_resource_binding uuid;
  v_resource_kind text;
  v_provider_resource_id text;
  v_reference_resource uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'provider lifecycle events are append-only'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(NEW.application_account_id);

  SELECT binding_id INTO v_operation_binding
  FROM public.provider_lifecycle_operations
  WHERE id = NEW.operation_id
    AND application_account_id = NEW.application_account_id
    AND origin_scope_key = NEW.origin_scope_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider lifecycle event operation graph is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.resource_id IS NOT NULL THEN
    SELECT binding_id, kind, provider_resource_id
    INTO v_resource_binding, v_resource_kind, v_provider_resource_id
    FROM public.provider_resources
    WHERE id = NEW.resource_id
      AND application_account_id = NEW.application_account_id
      AND origin_scope_key = NEW.origin_scope_key;
    IF NOT FOUND OR v_resource_binding <> v_operation_binding THEN
      RAISE EXCEPTION 'provider lifecycle event resource graph is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.reference_id IS NOT NULL THEN
    SELECT reference.resource_id, resource.binding_id
    INTO v_reference_resource, v_resource_binding
    FROM public.provider_consumer_references AS reference
    JOIN public.provider_resources AS resource ON resource.id = reference.resource_id
    WHERE reference.id = NEW.reference_id
      AND reference.application_account_id = NEW.application_account_id
      AND reference.origin_scope_key = NEW.origin_scope_key;
    IF NOT FOUND
       OR v_resource_binding <> v_operation_binding
       OR (NEW.resource_id IS NOT NULL AND v_reference_resource <> NEW.resource_id) THEN
      RAISE EXCEPTION 'provider lifecycle event reference graph is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF (NEW.observed_resource_kind IS NULL) <> (NEW.observed_provider_resource_id IS NULL) THEN
    RAISE EXCEPTION 'provider lifecycle event observed resource identity must be complete'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.private_evidence_ref IS NOT NULL
     AND NOT public.provider_lifecycle_internal_ref_is_safe(NEW.private_evidence_ref) THEN
    RAISE EXCEPTION 'provider lifecycle event evidence reference is not an internal path'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.path_template IS NOT NULL AND (
    pg_catalog.octet_length(NEW.path_template) > 255
    OR NEW.path_template !~ '^/[A-Za-z0-9_./{}-]+$'
    OR pg_catalog.strpos(NEW.path_template, '//') > 0
    OR NEW.path_template ~ '(^|/)[.]{1,2}(/|$)'
  ) THEN
    RAISE EXCEPTION 'provider lifecycle event path template is not a fixed internal template'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.resource_id IS NOT NULL
     AND NEW.observed_resource_kind IS NOT NULL
     AND (NEW.observed_resource_kind IS DISTINCT FROM v_resource_kind
          OR NEW.observed_provider_resource_id IS DISTINCT FROM v_provider_resource_id) THEN
    RAISE EXCEPTION 'provider lifecycle event observed identity does not match its resource'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_lifecycle_events_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION public.provider_lifecycle_events_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.provider_approval_claim_resources_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claim record;
  v_resource record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'provider approval resource scope is append-only'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.provider_lifecycle_assert_account_guard(NEW.application_account_id);

  SELECT binding_id, application_account_id, origin_scope_key,
         consumed_at, revoked_at, expires_at
  INTO v_claim
  FROM public.provider_approval_claims
  WHERE id = NEW.claim_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_claim.application_account_id <> NEW.application_account_id
     OR v_claim.origin_scope_key <> NEW.origin_scope_key THEN
    RAISE EXCEPTION 'provider approval resource claim graph is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF v_claim.consumed_at IS NOT NULL OR v_claim.revoked_at IS NOT NULL
     OR v_claim.expires_at <= statement_timestamp() THEN
    RAISE EXCEPTION 'provider approval resource scope cannot widen after consumption, revocation, or expiry'
      USING ERRCODE = '23514';
  END IF;

  SELECT binding_id, application_account_id, origin_scope_key,
         verified_account_scope_id
  INTO v_resource
  FROM public.provider_resources
  WHERE id = NEW.resource_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_resource.binding_id <> v_claim.binding_id
     OR v_resource.application_account_id <> NEW.application_account_id
     OR v_resource.origin_scope_key <> NEW.origin_scope_key
     OR v_resource.verified_account_scope_id IS NULL THEN
    RAISE EXCEPTION 'provider approval resource is outside the exact verified target graph'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.provider_account_binding_promotions
    WHERE binding_id = v_claim.binding_id
      AND application_account_id = NEW.application_account_id
      AND origin_scope_key = NEW.origin_scope_key
      AND verified_account_scope_id = v_resource.verified_account_scope_id
      AND state = 'verified'
  ) THEN
    RAISE EXCEPTION 'provider approval resource lacks the binding active verified promotion'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER provider_approval_claim_resources_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.provider_approval_claim_resources
FOR EACH ROW EXECUTE FUNCTION public.provider_approval_claim_resources_guard();
