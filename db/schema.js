import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  name: text('name').notNull().default('Video OS Account'),
  role: text('role').notNull().default('customer'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').references(() => users.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  challengeType: text('challenge_type').notNull().default('magic_link'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('auth_challenges_account_created_idx').on(table.accountId, table.createdAt), index('auth_challenges_expires_idx').on(table.expiresAt)]);

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sessionHash: text('session_hash').notNull().unique(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
}, (table) => [index('auth_sessions_account_expires_idx').on(table.accountId, table.expiresAt), index('auth_sessions_expires_idx').on(table.expiresAt)]);

export const entitlements = pgTable('entitlements', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entitlementKey: text('entitlement_key').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('entitlements_account_key_uq').on(table.accountId, table.entitlementKey), index('entitlements_account_enabled_idx').on(table.accountId, table.enabled)]);

export const creditAccounts = pgTable('credit_accounts', {
  accountId: text('account_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  purchased: integer('purchased').notNull().default(0),
  spent: integer('spent').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  identityId: uuid('identity_id').references(() => userIdentities.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  script: text('script').notNull(),
  avatar: jsonb('avatar').notNull().default({}),
  voice: jsonb('voice').notNull().default({}),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('projects_account_updated_idx').on(table.accountId, table.updatedAt)]);

export const videoJobs = pgTable('video_jobs', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  idempotencyKey: text('idempotency_key').notNull(),
  workflowRunId: text('workflow_run_id').unique(),
  correlationId: text('correlation_id').notNull(),
  provider: text('provider').notNull(),
  providerJobId: text('provider_job_id').unique(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  format: text('format').notNull(),
  costCredits: integer('cost_credits').notNull(),
  providerCostUsd: numeric('provider_cost_usd', { precision: 12, scale: 4 }),
  input: jsonb('input').notNull().default({}),
  output: jsonb('output').notNull().default({}),
  failureCategory: text('failure_category'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [uniqueIndex('video_jobs_account_idempotency_uq').on(table.accountId, table.idempotencyKey), index('video_jobs_account_updated_idx').on(table.accountId, table.updatedAt), index('video_jobs_status_updated_idx').on(table.status, table.updatedAt)]);

export const jobEvents = pgTable('job_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: text('job_id').notNull().references(() => videoJobs.id, { onDelete: 'cascade' }),
  correlationId: text('correlation_id').notNull(),
  eventType: text('event_type').notNull(),
  stageFrom: text('stage_from'),
  stageTo: text('stage_to'),
  failureCategory: text('failure_category'),
  details: jsonb('details').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('job_events_job_created_idx').on(table.jobId, table.createdAt)]);

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  amount: integer('amount').notNull(),
  balanceAfter: integer('balance_after').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('credit_transactions_source_uq').on(table.sourceType, table.sourceId), index('credit_transactions_account_created_idx').on(table.accountId, table.createdAt)]);

export const stripeEvents = pgTable('stripe_events', {
  stripeEventId: text('stripe_event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  livemode: boolean('livemode').notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  accountId: text('account_id').references(() => users.id),
  sessionId: text('session_id').unique(),
  status: text('status').notNull().default('received'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobId: text('job_id').references(() => videoJobs.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  privatePathname: text('private_pathname').notNull().unique(),
  contentType: text('content_type').notNull(),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256').notNull(),
  widthPx: integer('width_px'),
  heightPx: integer('height_px'),
  durationMs: integer('duration_ms'),
  provider: text('provider'),
  providerAssetId: text('provider_asset_id'),
  providerUploadedAt: timestamp('provider_uploaded_at', { withTimezone: true }),
  quarantinedAt: timestamp('quarantined_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('media_assets_provider_asset_uq').on(table.provider, table.providerAssetId).where(sql`${table.provider} is not null and ${table.providerAssetId} is not null`),
  check('media_assets_dimensions_positive_ck', sql`(${table.widthPx} is null or ${table.widthPx} > 0) and (${table.heightPx} is null or ${table.heightPx} > 0)`),
  check('media_assets_duration_positive_ck', sql`${table.durationMs} is null or ${table.durationMs} > 0`),
]);

export const userIdentities = pgTable('user_identities', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  overallStatus: text('overall_status').notNull().default('DRAFT'),
  avatarStatus: text('avatar_status').notNull().default('DRAFT'),
  voiceStatus: text('voice_status').notNull().default('DRAFT'),
  provider: text('provider').notNull().default('heygen'),
  sourcePhotoAssetId: uuid('source_photo_asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'restrict' }),
  sourceVoiceAssetId: uuid('source_voice_asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'restrict' }),
  providerAvatarRequestId: text('provider_avatar_request_id'),
  providerAvatarGroupId: text('provider_avatar_group_id'),
  providerRenderableAvatarId: text('provider_renderable_avatar_id'),
  providerVoiceId: text('provider_voice_id'),
  avatarOperationKey: uuid('avatar_operation_key'),
  voiceOperationKey: uuid('voice_operation_key'),
  avatarFailureCode: text('avatar_failure_code'),
  avatarFailureMessage: text('avatar_failure_message'),
  voiceFailureCode: text('voice_failure_code'),
  voiceFailureMessage: text('voice_failure_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  index('user_identities_account_updated_idx').on(table.accountId, table.updatedAt),
  index('user_identities_account_status_idx').on(table.accountId, table.overallStatus),
  uniqueIndex('user_identities_provider_group_uq').on(table.provider, table.providerAvatarGroupId).where(sql`${table.providerAvatarGroupId} is not null`),
  uniqueIndex('user_identities_provider_avatar_uq').on(table.provider, table.providerRenderableAvatarId).where(sql`${table.providerRenderableAvatarId} is not null`),
  uniqueIndex('user_identities_provider_voice_uq').on(table.provider, table.providerVoiceId).where(sql`${table.providerVoiceId} is not null`),
  uniqueIndex('user_identities_avatar_operation_uq').on(table.avatarOperationKey).where(sql`${table.avatarOperationKey} is not null`),
  uniqueIndex('user_identities_voice_operation_uq').on(table.voiceOperationKey).where(sql`${table.voiceOperationKey} is not null`),
  check('user_identities_overall_status_ck', sql`${table.overallStatus} in ('DRAFT', 'UPLOADING', 'CREATING_AVATAR', 'CLONING_VOICE', 'PROCESSING', 'READY', 'PARTIAL_FAILURE', 'FAILED', 'ARCHIVED')`),
  check('user_identities_avatar_status_ck', sql`${table.avatarStatus} in ('DRAFT', 'UPLOADING', 'CREATING', 'PROCESSING', 'READY', 'FAILED')`),
  check('user_identities_voice_status_ck', sql`${table.voiceStatus} in ('DRAFT', 'UPLOADING', 'CREATING', 'PROCESSING', 'READY', 'FAILED')`),
]);

export const identityConsents = pgTable('identity_consents', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  identityId: uuid('identity_id').notNull().references(() => userIdentities.id, { onDelete: 'cascade' }),
  faceAuthorization: boolean('face_authorization').notNull(),
  voiceAuthorization: boolean('voice_authorization').notNull(),
  providerProcessingAuthorization: boolean('provider_processing_authorization').notNull(),
  archiveDeleteAcknowledgment: boolean('archive_delete_acknowledgment').notNull(),
  policyVersion: text('policy_version').notNull(),
  photoSha256: text('photo_sha256').notNull(),
  voiceSha256: text('voice_sha256').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('identity_consents_account_identity_idx').on(table.accountId, table.identityId, table.acceptedAt),
  uniqueIndex('identity_consents_active_policy_uq').on(table.identityId, table.policyVersion).where(sql`${table.revokedAt} is null`),
  check('identity_consents_authorizations_ck', sql`${table.faceAuthorization} and ${table.voiceAuthorization} and ${table.providerProcessingAuthorization} and ${table.archiveDeleteAcknowledgment}`),
]);

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
