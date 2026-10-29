import { z } from 'zod';

// Response bodies of the `/v2` API (the `body` of the envelope), derived from the Rust structs.
// serde conventions: enums are snake_case (Network is lowercase), `Option<T>` is `T | null`.

export const networkSchema = z.enum([
  'mainnet',
  'testnet',
  'signet',
  'regtest',
]);
export type Network = z.infer<typeof networkSchema>;

export const urgencySchema = z.enum(['low', 'normal', 'high']);
export type Urgency = z.infer<typeof urgencySchema>;

export const routeKindSchema = z.enum([
  'rbf',
  'cpfp',
  'external_accelerator',
  'wait',
]);
export type RouteKind = z.infer<typeof routeKindSchema>;

export const txStatusSchema = z.enum([
  'pending',
  'replaced',
  'confirmed',
  'not_found',
]);
export type TxStatus = z.infer<typeof txStatusSchema>;

export const jobStateSchema = z.enum([
  'awaiting_signature',
  'broadcasting',
  'broadcast',
  'confirmed',
  'settled',
  'obsolete',
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const estimateSourceSchema = z.enum([
  'node',
  'fallback',
  'third_party',
  'unavailable',
]);
export type EstimateSource = z.infer<typeof estimateSourceSchema>;

/** Per-target estimate. `approximate` is absent in snapshots stored before it existed. */
export const targetEstimateSchema = z.object({
  blocks: z.number().int(),
  sat_per_vb: z.number().nullable(),
  source: estimateSourceSchema,
  approximate: z.boolean().default(false),
});
export type TargetEstimate = z.infer<typeof targetEstimateSchema>;

export const feeSnapshotSchema = z.object({
  schema_version: z.number().int(),
  network: networkSchema,
  /** Unix seconds. */
  fetched_at: z.number(),
  unit: z.string(),
  estimates: z.array(targetEstimateSchema),
  min_relay_fee_sat_per_vb: z.number().nullable(),
  mempool_min_fee_sat_per_vb: z.number().nullable(),
  source: z.string(),
});
export type FeeSnapshot = z.infer<typeof feeSnapshotSchema>;

export const freshnessPolicySchema = z.object({
  recent_secs: z.number(),
  stale_secs: z.number(),
});
export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;

export const refreshErrorSchema = z.object({
  at: z.number(),
  message: z.string(),
});
export type RefreshError = z.infer<typeof refreshErrorSchema>;

export const refreshStatusSchema = z.object({
  ok: z.boolean(),
  served_from_cache: z.boolean(),
  code: z.string().nullable().default(null),
});
export type RefreshStatus = z.infer<typeof refreshStatusSchema>;

export const feesBodySchema = z.object({
  snapshot: feeSnapshotSchema.nullable(),
  last_error: refreshErrorSchema.nullable(),
  policy: freshnessPolicySchema,
  /** Server clock, unix seconds, when it answered. */
  server_time: z.number(),
  /** Absent from `/fees/latest`. */
  refresh: refreshStatusSchema.optional(),
});
export type FeesBody = z.infer<typeof feesBodySchema>;

export const eligibilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('feasible') }),
  z.object({ state: z.literal('infeasible'), reason: z.string() }),
  z.object({ state: z.literal('unknown'), missing: z.string() }),
]);
export type Eligibility = z.infer<typeof eligibilitySchema>;

export const txAnalysisSchema = z.object({
  txid: z.string(),
  network: networkSchema,
  status: txStatusSchema,
  confirmations: z.number().int(),
  vsize: z.number(),
  fee_sat: z.number().nullable(),
  signals_rbf: z.boolean().nullable(),
  unconfirmed_ancestors: z.number().int(),
  unconfirmed_descendants: z.number().int(),
  target_fee_rate: z.number().nullable(),
});
export type TxAnalysis = z.infer<typeof txAnalysisSchema>;

export const routeOptionSchema = z.object({
  kind: routeKindSchema,
  eligibility: eligibilitySchema,
  network_fee_sat: z.number().nullable(),
  service_fee_sat: z.number().nullable(),
  notes: z.array(z.string()),
});
export type RouteOption = z.infer<typeof routeOptionSchema>;

export const recommendationSchema = z.object({
  analysis: txAnalysisSchema,
  options: z.array(routeOptionSchema),
  recommended: routeKindSchema,
  rationale: z.string(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const jobCreatedSchema = z.object({
  job_id: z.string(),
  route: routeKindSchema,
  /** Unsigned PSBT, base64. */
  psbt: z.string(),
  fee_sat: z.number(),
  extra_fee_sat: z.number(),
  description: z.string(),
  next_step: z.string(),
});
export type JobCreated = z.infer<typeof jobCreatedSchema>;

export const jobSchema = z.object({
  id: z.string(),
  txid: z.string(),
  route: routeKindSchema,
  state: jobStateSchema,
  unsigned_psbt: z.string(),
  extra_fee_sat: z.number(),
  recovery_txid: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

/** A tracker row. `status` is a free string on the server (it is a TxStatus in practice). */
export const historyEntrySchema = z.object({
  txid: z.string(),
  status: z.string(),
  confirmations: z.number().int(),
  detail: z.string().nullable(),
  observed_at: z.string(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historySchema = z.array(historyEntrySchema);

export const orderStateSchema = z.enum([
  'awaiting_verification',
  'seen',
  'replaced',
  'not_seen',
]);
export type OrderState = z.infer<typeof orderStateSchema>;

export const upsertOutcomeSchema = z.enum(['created', 'existing', 'conflict']);
export type UpsertOutcome = z.infer<typeof upsertOutcomeSchema>;

export const observationSchema = z.object({
  status: txStatusSchema,
  confirmations: z.number().int(),
  fee_rate_sat_vb: z.number().nullable(),
  target_fee_rate_sat_vb: z.number().nullable(),
  fee_below_target: z.boolean().nullable(),
});
export type Observation = z.infer<typeof observationSchema>;

export const syncResultSchema = z.object({
  idempotency_key: z.string(),
  outcome: upsertOutcomeSchema,
  state: orderStateSchema,
  note: z.string(),
  observation: observationSchema.nullable(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

export const syncBodySchema = z.object({ results: z.array(syncResultSchema) });
export type SyncBody = z.infer<typeof syncBodySchema>;
