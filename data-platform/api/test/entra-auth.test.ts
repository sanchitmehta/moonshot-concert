import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ServiceError } from "../src/errors.ts";
import { buildApp, type Dependencies } from "../src/http/app.ts";
import { entraAuthenticator } from "../src/http/entra-auth.ts";

const tenantId = "11111111-1111-1111-1111-111111111111";
const audience = "api://data-platform";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
const authenticate = entraAuthenticator({ tenantId, audiences: [audience], requiredRole: "DataPlatform.Access", adminRole: "DataPlatform.Admin", keys });

const token = (claims: Record<string, unknown>, issuer = `https://sts.windows.net/${tenantId}/`, aud = audience) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(aud)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);

const rejectsWith = (status: number) => (error: unknown) => error instanceof ServiceError && error.status === status;

describe("Entra authentication", () => {
  test("accepts a token for this API that holds the app role", async () => {
    await authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] })}`, "api");
    await authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] }, `https://login.microsoftonline.com/${tenantId}/v2.0`)}`, "api");
  });

  test("rejects missing, foreign, and wrong-audience tokens with 401", async () => {
    await assert.rejects(authenticate(undefined, "api"), rejectsWith(401));
    await assert.rejects(authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] }, "https://sts.windows.net/other/")}`, "api"), rejectsWith(401));
    await assert.rejects(authenticate(`Bearer ${await token({ roles: ["DataPlatform.Access"] }, undefined, "api://other")}`, "api"), rejectsWith(401));
  });

  test("rejects a valid token without the app role with 403", async () => {
    await assert.rejects(authenticate(`Bearer ${await token({})}`, "api"), rejectsWith(403));
  });
});

describe("admin routes", () => {
  const restocked = {
    offers: [{ offerId: "crater-club", allocation: 46, remaining: 40, previousRemaining: 0 }],
    skipped: [{ offerId: "retired-pass", reason: "NOT_IN_SEED" }],
  };
  const setup = () => {
    const calls = { restock: [] as { offerId: string; allocation: number }[][], invalidated: [] as string[] };
    const lines: Record<string, unknown>[] = [];
    const deps = {
      authenticate,
      inventory: { restock: async (starting: { offerId: string; allocation: number }[]) => (calls.restock.push(starting), restocked) },
      availability: { invalidate: async (offerId: string) => void calls.invalidated.push(offerId) },
      catalog: { festival: async () => ({ name: "Moonshot Fest" }) },
      version: { service: "data-platform-api", version: "test", commit: "test" },
    } as unknown as Dependencies;
    const app = buildApp(deps, { logger: { level: "info", stream: { write: line => lines.push(JSON.parse(line)) } } });
    return { app, calls, lines };
  };
  const bearer = async (roles: string[]) => ({ authorization: `Bearer ${await token({ roles })}` });

  test("restock needs DataPlatform.Admin, which grants no other route", async () => {
    const { app, calls } = setup();
    const access = await bearer(["DataPlatform.Access"]);
    const admin = await bearer(["DataPlatform.Admin"]);
    const status = async (method: "GET" | "POST", url: string, headers = {}) => (await app.inject({ method, url, headers })).statusCode;

    assert.equal(await status("POST", "/v1/admin/restock"), 401);
    assert.equal(await status("POST", "/v1/admin/restock", access), 403);
    assert.equal(await status("POST", "/v1/%61dmin/restock", access), 403, "an encoded path is checked as the route it reaches");
    assert.equal(await status("GET", "/v1/festival", admin), 403);
    assert.equal(await status("GET", "/v1/offers", admin), 403);
    assert.equal(await status("GET", "/%761/festival"), 401);
    assert.equal(calls.restock.length, 0);
    assert.equal(await status("GET", "/v1/festival", access), 200);
    assert.equal(await status("POST", "/v1/admin/restock", admin), 200);
    await app.close();
  });

  test("restock returns every seeded pass to its starting quantity and clears its cached snapshot", async () => {
    const { app, calls, lines } = setup();
    const headers = await bearer(["DataPlatform.Admin"]);
    const post = (extra: { payload?: string; headers?: Record<string, string> } = {}) =>
      app.inject({ method: "POST", url: "/v1/admin/restock", payload: extra.payload, headers: { ...headers, ...extra.headers } });
    const json = { "content-type": "application/json" };

    const response = await post();
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(!Number.isNaN(Date.parse(body.restockedAt)));
    assert.deepEqual({ offers: body.offers, skipped: body.skipped }, restocked);
    assert.equal(calls.restock[0]!.length, 17, "every seeded pass");
    assert.equal(calls.restock[0]!.find(offer => offer.offerId === "crater-club")?.allocation, 40);
    assert.deepEqual(calls.invalidated, ["crater-club"]);
    const logged = lines.find(line => line.msg === "Inventory restocked");
    assert.deepEqual({ offers: logged?.offers, unitsAdded: logged?.unitsAdded }, { offers: 1, unitsAdded: 40 });

    assert.equal((await post({ payload: "", headers: json })).statusCode, 200);
    assert.equal((await post({ payload: "{}", headers: json })).statusCode, 200);
    assert.equal((await post({ payload: '{"offerId":"crater-club"}', headers: json })).statusCode, 400);
    assert.equal((await post({ payload: "{", headers: json })).statusCode, 400);
    await app.close();
  });
});
