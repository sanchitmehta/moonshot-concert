import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ServiceError } from "../src/errors.ts";
import { entraAuthenticator } from "../src/http/entra-auth.ts";

const tenantId = "11111111-1111-1111-1111-111111111111";
const audience = "api://data-platform";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const authenticate = entraAuthenticator({ tenantId, audiences: [audience], requiredRole: "DataPlatform.Access", keys });

const token = (claims: Record<string, unknown>, issuer = `https://sts.windows.net/${tenantId}/`, aud = audience) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(aud)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);

const rejectsWith = (status: number) => (error: unknown) => error instanceof ServiceError && error.status === status;

describe("Entra authentication", () => {
  test("accepts a token for this API that holds the app role", async () => {
    await authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] })}`);
    await authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] }, `https://login.microsoftonline.com/${tenantId}/v2.0`)}`);
  });

  test("rejects missing, foreign, and wrong-audience tokens with 401", async () => {
    await assert.rejects(authenticate(undefined), rejectsWith(401));
    await assert.rejects(authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] }, "https://sts.windows.net/other/")}`), rejectsWith(401));
    await assert.rejects(authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] }, undefined, "api://other")}`), rejectsWith(401));
  });

  test("rejects a valid token without the app role with 403", async () => {
    await assert.rejects(authenticate(`Bearer ${await token({})}`), rejectsWith(403));
  });
});
