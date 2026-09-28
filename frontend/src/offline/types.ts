export const OFFLINE_SCHEMA_VERSION = 1 as const

export type OfflineMutationStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'conflict'
  | 'access_expired'
  | 'failed'

export interface OfflineWorkPackage<TContext = unknown> {
  schemaVersion: typeof OFFLINE_SCHEMA_VERSION
  packageId: string
  workOrderId: string
  engineerId: string
  grantId: string
  expectedVersion: number
  preparedAt: string
  accessExpiresAt: string
  context: TContext
  checksum?: string
}

export interface PrepareOfflinePackageInput<TContext = unknown> {
  packageId?: string
  workOrderId: string
  engineerId: string
  grantId: string
  expectedVersion: number
  preparedAt?: string
  accessExpiresAt: string
  context: TContext
  checksum?: string
}

export interface EngineerResultPayload {
  report: {
    summary: string
    diagnosis?: string
    workPerformed?: string
    laborMinutes?: number
    partsUsed?: Array<{
      name: string
      quantity: number
      unit?: string
    }>
    recommendation?: string
    clientDraftId?: string
    updatedAt: string
  }
}

export interface OfflineMutationError {
  code: string
  message: string
  retryable: boolean
}

export interface OfflineMutationConflict<TServerState = unknown> {
  message: string
  serverVersion?: number
  serverState?: TServerState
  detectedAt: string
}

export interface OfflineMutation<TPayload = unknown, TServerState = unknown> {
  mutationId: string
  idempotencyKey: string
  sequence: number
  kind: string
  workOrderId: string
  engineerId: string
  grantId: string
  expectedVersion: number
  payload: TPayload
  status: OfflineMutationStatus
  attempts: number
  createdAt: string
  updatedAt: string
  lastAttemptAt?: string
  syncClaimId?: string
  syncLeaseExpiresAt?: string
  syncedAt?: string
  remoteVersion?: number
  receipt?: unknown
  lastError?: OfflineMutationError
  conflict?: OfflineMutationConflict<TServerState>
}

export interface EnqueueOfflineMutationInput<TPayload = unknown> {
  mutationId?: string
  idempotencyKey: string
  kind: string
  workOrderId: string
  engineerId: string
  grantId: string
  expectedVersion: number
  payload: TPayload
  createdAt?: string
}

export interface OfflineMutationFilter {
  workOrderId?: string
  statuses?: readonly OfflineMutationStatus[]
}

export interface OfflineSyncRequest<TPayload = unknown, TContext = unknown> {
  mutation: OfflineMutation<TPayload>
  workPackage: OfflineWorkPackage<TContext>
}

export type OfflineSyncResult<TServerState = unknown> =
  | {
      status: 'synced'
      remoteVersion?: number
      receipt?: unknown
    }
  | {
      status: 'conflict'
      message: string
      serverVersion?: number
      serverState?: TServerState
    }
  | {
      status: 'access_expired'
      message: string
    }
  | {
      status: 'failed'
      code?: string
      message: string
      retryable?: boolean
    }

export type OfflineSyncTransport<
  TPayload = unknown,
  TContext = unknown,
  TServerState = unknown,
> = (
  request: OfflineSyncRequest<TPayload, TContext>,
) => Promise<OfflineSyncResult<TServerState>>

export interface OfflineSyncOptions {
  retryFailed?: boolean
  workOrderId?: string
}

export interface OfflineSyncSummary {
  processedMutationIds: string[]
  skippedMutationIds: string[]
  counts: Record<OfflineMutationStatus, number>
}

export interface RequeueMutationPatch<TPayload = unknown> {
  payload?: TPayload
  expectedVersion?: number
  grantId?: string
  idempotencyKey?: string
}

export interface OfflineStorage {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

export interface OfflineSnapshot {
  schemaVersion: typeof OFFLINE_SCHEMA_VERSION
  nextSequence: number
  packages: Record<string, OfflineWorkPackage>
  mutations: Record<string, OfflineMutation>
  idempotencyIndex: Record<string, string>
}
