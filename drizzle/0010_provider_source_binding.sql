-- Preserve the immutable media provenance of each originating operation.
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

  SELECT binding_id, application_account_id, origin_scope_key, kind, state,
         source_sha256, source_bytes
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
  IF NEW.source_sha256 IS DISTINCT FROM v_origin.source_sha256
     OR NEW.source_bytes IS DISTINCT FROM v_origin.source_bytes THEN
    RAISE EXCEPTION 'provider resource source provenance must exactly match its origin operation'
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
