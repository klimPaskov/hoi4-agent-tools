import type { Diagnostic } from './diagnostics.js';

export type ServiceStatus = 'ok' | 'blocked' | 'error';

export interface ArtifactLink {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
  sha256?: string;
  description?: string;
}

export interface ValidationSummary {
  passed: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    message: string;
  }>;
}

export interface ServiceResult<T = Record<string, never>> {
  status: ServiceStatus;
  code: string;
  workspaceId: string;
  filesScanned: string[];
  proposedFiles: string[];
  changedFiles: string[];
  diagnostics: Diagnostic[];
  transactionId?: string;
  planHash?: string;
  artifacts: ArtifactLink[];
  validation: ValidationSummary;
  blockers: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  rollbackStatus?: 'not-required' | 'available' | 'applied' | 'failed';
  data: T;
}

export function emptyServiceResult<T>(workspaceId: string, data: T): ServiceResult<T> {
  return {
    status: 'ok',
    code: 'OK',
    workspaceId,
    filesScanned: [],
    proposedFiles: [],
    changedFiles: [],
    diagnostics: [],
    artifacts: [],
    validation: { passed: true, checks: [] },
    blockers: [],
    data,
  };
}

export class ServiceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
