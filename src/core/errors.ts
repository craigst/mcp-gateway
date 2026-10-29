/**
 * Structured JSON-RPC / gateway error types.
 *
 * Protocol error codes follow JSON-RPC 2.0 (-32700..-32603).
 * Gateway-specific codes live in the reserved server-error range (-32000..-32099)
 * as required by the specification (Access Denied = -32001).
 */

export const ErrorCodes = {
  // JSON-RPC 2.0 standard
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Gateway extensions
  ACCESS_DENIED: -32001,
  TOOL_NOT_FOUND: -32002,
  DELEGATION_DEPTH_EXCEEDED: -32003,
  ESCALATION_REQUIRED: -32004,
  KEY_INVALID: -32005,
  RATE_LIMITED: -32006,
  UPSTREAM_ERROR: -32007,
  NOT_IMPLEMENTED: -32008,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorData {
  status?: string;
  reason?: string;
  ticket_id?: string;
  escalation_supported?: boolean;
  tool_id?: string;
  server_id?: string;
  details?: unknown;
}

export class GatewayError extends Error {
  readonly code: ErrorCode | number;
  readonly data: ErrorData | undefined;
  readonly httpStatus: number;

  constructor(
    code: ErrorCode | number,
    message: string,
    options: { data?: ErrorData; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GatewayError';
    this.code = code;
    this.data = options.data;
    this.httpStatus =
      options.httpStatus ?? (code === ErrorCodes.ACCESS_DENIED ? 403 : code === ErrorCodes.KEY_INVALID ? 401 : 400);
  }

  toJSONRpcError(): { code: number; message: string; data?: ErrorData } {
    const error: { code: number; message: string; data?: ErrorData } = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) error.data = this.data;
    return error;
  }
}

/** Raised when a key is missing, malformed, revoked or expired. */
export function invalidKey(reason = 'INVALID_API_KEY'): GatewayError {
  return new GatewayError(ErrorCodes.KEY_INVALID, 'Unauthorized: invalid or missing API key.', {
    data: { status: 'UNAUTHORIZED', reason },
    httpStatus: 401,
  });
}

/**
 * Structured access denial. Deliberately generic at the message level to prevent
 * key probing, while carrying machine-readable reason + escalation ticket data.
 */
export function accessDenied(
  message: string,
  options: { reason?: string; ticketId?: string; escalationSupported?: boolean; toolId?: string; serverId?: string } = {},
): GatewayError {
  return new GatewayError(ErrorCodes.ACCESS_DENIED, message, {
    data: {
      status: 'FORBIDDEN',
      reason: options.reason ?? 'SCOPE_RESTRICTION',
      ...(options.ticketId ? { ticket_id: options.ticketId } : {}),
      ...(options.escalationSupported ? { escalation_supported: true } : {}),
      ...(options.toolId ? { tool_id: options.toolId } : {}),
      ...(options.serverId ? { server_id: options.serverId } : {}),
    },
    httpStatus: 403,
  });
}

/** Indistinguishable "not found" used for invisible tools (anti-probing). */
export function toolNotFound(toolId?: string): GatewayError {
  return new GatewayError(ErrorCodes.TOOL_NOT_FOUND, 'Tool Not Found', {
    data: { status: 'NOT_FOUND', ...(toolId ? { tool_id: toolId } : {}) },
    httpStatus: 404,
  });
}

export function invalidParams(message: string, details?: unknown): GatewayError {
  return new GatewayError(ErrorCodes.INVALID_PARAMS, message, {
    data: { status: 'INVALID_PARAMS', details },
    httpStatus: 400,
  });
}

export function internalError(message: string, cause?: unknown): GatewayError {
  return new GatewayError(ErrorCodes.INTERNAL_ERROR, message, { cause, httpStatus: 500 });
}

export function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return internalError(message, error);
}
