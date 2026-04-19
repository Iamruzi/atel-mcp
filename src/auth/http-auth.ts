import type { Request } from 'express';

export function getAuthorizationHeader(req: Request): string | null {
  return req.header('authorization') || null;
}
