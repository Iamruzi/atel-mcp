import type { AtelEnvironmentProfile } from '../config.js';
import type { AtelScope } from '../contracts/scopes.js';

export interface RemoteBearerClaims {
  sub: string;
  did: string;
  env: AtelEnvironmentProfile;
  scopes: AtelScope[];
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  clientId?: string;
}

export interface PlatformSessionEnvelope {
  did: string;
  environment?: AtelEnvironmentProfile | string;
  scopes?: string[];
  sessionId?: string;
  issuedAt?: number;
  expiresAt?: number;
  clientId?: string;
}

export interface AtelSession {
  subject: string;
  did: string;
  environment: AtelEnvironmentProfile;
  scopes: AtelScope[];
  bearerToken: string;
  sessionId: string;
  expiresAt: number;
  clientId?: string;
}

export interface SessionResolverInput {
  authorization?: string | null;
  requestId: string;
  toolName?: string;
}

export interface ScopeCheckOptions {
  requireAll?: AtelScope[];
  requireAny?: AtelScope[];
}

export interface EnvironmentGuardOptions {
  allowed: AtelEnvironmentProfile[];
}

export type PrerequisiteCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: 'PREREQUISITE_NOT_MET' | 'INSUFFICIENT_BALANCE' | 'ENVIRONMENT_MISMATCH';
      message: string;
      details?: Record<string, unknown>;
    };
