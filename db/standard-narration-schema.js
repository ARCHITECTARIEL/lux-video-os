import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { identityConsents, mediaAssets, projects, userIdentities, users } from './schema.js';

// Standard (SadTalker Stage A) narration consent: authorizes using one exact
// uploaded audio asset as driven narration for one exact project/identity.
// This is separate from identityConsents, which authorizes the identity's own
// source photo/voice for avatar/voice creation -- narration consent is scoped
// to "use this uploaded recording as narration for this render", not
// "clone this voice".
export const standardNarrationConsents = pgTable('standard_narration_consents', {
  id: uuid('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  identityId: uuid('identity_id').notNull().references(() => userIdentities.id, { onDelete: 'cascade' }),
  audioAssetId: uuid('audio_asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'restrict' }),
  audioSha256: text('audio_sha256').notNull(),
  policyVersion: text('policy_version').notNull(),
  processingScope: text('processing_scope').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: text('revoked_by'),
}, (table) => [
  uniqueIndex('standard_narration_consents_account_idempotency_uq').on(table.accountId, table.idempotencyKey),
  uniqueIndex('standard_narration_consents_binding_idx').on(table.accountId, table.actorId, table.projectId, table.identityId, table.audioAssetId, table.grantedAt),
]);

// One quote binds an exact narration consent + source fingerprints + format to
// a credit price for a bounded TTL. consumedJobId is set exactly once, when a
// render reservation is created from this quote -- it is the mechanism that
// prevents a replayed/duplicated render from spending the same quote twice.
export const standardNarrationQuotes = pgTable('standard_narration_quotes', {
  id: uuid('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  contractVersion: text('contract_version').notNull(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  identityId: uuid('identity_id').notNull().references(() => userIdentities.id, { onDelete: 'cascade' }),
  photoAssetId: uuid('photo_asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'restrict' }),
  photoSha256: text('photo_sha256').notNull(),
  identityConsentId: uuid('identity_consent_id').notNull().references(() => identityConsents.id, { onDelete: 'restrict' }),
  narrationConsentId: uuid('narration_consent_id').notNull().references(() => standardNarrationConsents.id, { onDelete: 'restrict' }),
  audioAssetId: uuid('audio_asset_id').notNull().references(() => mediaAssets.id, { onDelete: 'restrict' }),
  audioSha256: text('audio_sha256').notNull(),
  policyVersion: text('policy_version').notNull(),
  pricingVersion: text('pricing_version').notNull(),
  format: text('format').notNull(),
  credits: integer('credits').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedJobId: text('consumed_job_id'),
}, (table) => [
  uniqueIndex('standard_narration_quotes_consumed_job_uq').on(table.consumedJobId),
]);
