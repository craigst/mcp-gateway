import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A REST sub-router mounted under `/mcp/v1/admin`.
 *
 * Returns true when the URL matched one of its routes (including error
 * responses), false when another area should handle it.
 */
export interface AdminSubRouter {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}
