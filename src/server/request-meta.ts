import type { Request } from 'express';
import { randomUUID } from 'node:crypto';

export interface ExtractedRequestMeta {
  authorization?: string | null;
  requestId: string;
  idempotencyKey?: string;
  hostName?: string;
  userAgent?: string;
}

export function extractRequestMeta(req: Request): ExtractedRequestMeta {
  const requestId = String(req.header('x-request-id') || randomUUID());
  const idempotencyKey = req.header('idempotency-key') || undefined;
  const userAgent = req.header('user-agent') || undefined;
  const hostName = req.hostname || req.header('host') || undefined;
  const authorization = req.header('authorization') || null;
  return { authorization, requestId, idempotencyKey, hostName, userAgent };
}
