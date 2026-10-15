ALTER TABLE "video_jobs" ADD COLUMN "render_mode" text;
--> statement-breakpoint
CREATE FUNCTION video_os_render_mode_for_job(p_provider text, p_input jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_input ? 'renderMode' THEN CASE
      WHEN p_provider = 'heygen' AND p_input->>'renderMode' = 'premium_presenter_v1'
        AND p_input->>'contractVersion' = 'scripted-photo-v1' AND p_input->>'tier' = 'PREMIUM'
        AND NOT (p_input ? 'providerCapability') AND NOT (p_input ? 'lookBindings')
        THEN 'premium_presenter_v1'
      WHEN p_provider = 'heygen' AND p_input->>'renderMode' = 'luxify_cinematic_v1'
        AND p_input->>'contractVersion' = 'luxify-cinematic-v1'
        AND p_input->>'providerCapability' = 'cinematic_avatar'
        AND NOT (p_input ? 'tier') THEN 'luxify_cinematic_v1'
      WHEN p_provider = 'sadtalker' AND p_input->>'renderMode' = 'standard_narration_v1'
        AND p_input->>'contractVersion' = 'standard-narration-v1'
        THEN 'standard_narration_v1'
      ELSE NULL END
    WHEN p_input ? 'providerCapability' OR p_input ? 'lookBindings' THEN NULL
    WHEN p_input->>'contractVersion' = 'scripted-photo-v1' THEN CASE
      WHEN p_provider = 'heygen' AND p_input->>'tier' = 'STANDARD'
        THEN 'scripted_photo_standard_v1'
      WHEN p_provider = 'heygen' AND p_input->>'tier' = 'PREMIUM'
        THEN 'legacy_premium_v1'
      ELSE NULL END
    WHEN p_input->>'contractVersion' = 'standard-narration-v1' THEN CASE
      WHEN p_provider = 'sadtalker' THEN 'standard_narration_v1'
      ELSE NULL END
    WHEN p_input ? 'contractVersion' OR p_input ? 'tier' OR p_input ? 'providerCapability'
      OR p_input ? 'lookBindings' THEN NULL
    WHEN p_provider = 'sadtalker' THEN 'standard_narration_v1'
    WHEN p_provider = 'heygen' THEN 'legacy_premium_v1'
    ELSE NULL
  END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM video_jobs
    WHERE video_os_render_mode_for_job(provider, input) IS NULL) THEN
    RAISE EXCEPTION 'video_jobs contains unclassifiable render modes; reconcile before migration';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION video_jobs_render_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
  expected := video_os_render_mode_for_job(NEW.provider, NEW.input);
  IF expected IS NULL THEN
    RAISE EXCEPTION 'video_jobs render mode cannot be classified';
  END IF;
  IF NEW.render_mode IS NOT NULL AND NEW.render_mode IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'video_jobs render mode conflicts with source input';
  END IF;
  NEW.render_mode := expected;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER video_jobs_render_mode_guard_tg BEFORE INSERT OR UPDATE OF provider, input, render_mode
ON video_jobs FOR EACH ROW EXECUTE FUNCTION video_jobs_render_mode_guard();
--> statement-breakpoint
UPDATE video_jobs SET render_mode = video_os_render_mode_for_job(provider, input)
WHERE render_mode IS NULL;
--> statement-breakpoint
ALTER TABLE video_jobs ALTER COLUMN render_mode SET NOT NULL;
--> statement-breakpoint
ALTER TABLE video_jobs ADD CONSTRAINT video_jobs_render_mode_ck
CHECK (render_mode IN ('standard_narration_v1', 'scripted_photo_standard_v1',
  'premium_presenter_v1', 'luxify_cinematic_v1', 'legacy_premium_v1'));
