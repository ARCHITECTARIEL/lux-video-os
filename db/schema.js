import { boolean, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  name: text('name').notNull().default('Video OS Account'),
  role: text('role').notNull().default('customer'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const creditAccounts = pgTable('credit_accounts', {
  accountId: text('account_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  balance: integer('balance').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  purchased: integer('purchased').notNull().default(0),
  spent: integer('spent').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const videoJobs = pgTable('video_jobs', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  accountId: text('account_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
