import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ServiceError } from "../errors.ts";

/** `api` is every /v1 route except `/v1/admin/*`, which needs `admin`. Neither role grants the other. */
export type Access = "api" | "admin";

export type Authenticate = (authorization: string | undefined, access: Access) => Promise<void>;

export type EntraSettings = {
  tenantId: string;
  /** Accepted `aud` values: the application ID URI (v1 tokens) and the client ID (v2 tokens). */
  audiences: string[];
  /** App role that callers must hold, granted to the storefront-api's managed identity. */
  requiredRole: string;
  /** App role for /v1/admin routes, granted to the demo simulator's managed identity. */
  adminRole: string;
  /** Signing keys; defaults to the tenant's published keys. */
  keys?: JWTVerifyGetKey;
};

const unauthorized = () => new ServiceError(401, "UNAUTHORIZED", "A valid access token is required.");
const forbidden = () => new ServiceError(403, "FORBIDDEN", "The caller is not allowed to use this API.");

export function entraAuthenticator({ tenantId, audiences, requiredRole, adminRole, keys: signingKeys }: EntraSettings): Authenticate {
  const keys = signingKeys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
  const issuer = [`https://login.microsoftonline.com/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`];

  return async (authorization, access) => {
    const token = /^Bearer ([A-Za-z0-9._-]+)$/.exec(authorization ?? "")?.[1];
    if (!token) throw unauthorized();
    let roles: unknown;
    try {
      ({ payload: { roles } } = await jwtVerify(token, keys, { issuer, audience: audiences, algorithms: ["RS256"] }));
    } catch {
      throw unauthorized();
    }
    if (!Array.isArray(roles) || !roles.includes(access === "admin" ? adminRole : requiredRole)) throw forbidden();
  };
}
