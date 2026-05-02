/**
 * Pre-auth tool registry.
 *
 * Most MCP tools require an authenticated session (Bearer or DID-Sig)
 * before they can run. A small set of tools — namely `atel_register_user`
 * — must be callable WITHOUT a prior identity, because their whole job
 * is to mint that identity.
 *
 * Pre-auth tools share the dispatch chain (audit, scope-style logging)
 * but skip:
 *   - session introspection (no bearer to look up)
 *   - scope enforcement (no scopes granted yet)
 *   - runtime-link lookup (no DID to look up)
 *
 * Adding a tool here is a security decision — every entry is callable by
 * unauthenticated traffic. Keep the list short and audit each addition.
 */
export const PRE_AUTH_TOOLS = new Set<string>([
  'atel_register_user',
]);

export function isPreAuthTool(name: string): boolean {
  return PRE_AUTH_TOOLS.has(name);
}
