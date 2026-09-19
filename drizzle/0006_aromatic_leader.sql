ALTER TABLE "video_jobs" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "video_jobs" ADD COLUMN "video_deleted_at" timestamp with time zone;