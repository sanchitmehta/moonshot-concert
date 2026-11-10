import { readFileSync } from "node:fs";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleWithWebIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Signer } from "@aws-sdk/rds-signer";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { DefaultAzureCredential } from "@azure/identity";
import { EntraIdCredentialsProviderFactory } from "@redis/entraid";
import pg from "pg";
import { z } from "zod";
import { CatalogStore } from "./catalog/catalog-store.ts";
import { InventoryStore, poolConfig } from "./inventory/inventory-store.ts";

// Locally the containers accept connection strings. In the cloud every store is reached with the
// service's managed identity (AZURE_CLIENT_ID selects it) and no keys or passwords are configured.
//  - entra:   Azure Database for PostgreSQL accepts a Microsoft Entra token as the password.
//  - aws-iam: the managed identity gets an Entra token for AWS_FEDERATION_RESOURCE (issued with the
//             identity's own client ID as its audience), AWS STS exchanges it for the AWS_ROLE_ARN
//             role, and that role signs an Amazon RDS IAM token used as the password.
export const storageSettings = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH: z.enum(["password", "entra", "aws-iam"]).default("password"),
  DATABASE_CA_FILE: z.string().optional(),
  DATABASE_ADMIN_SECRET_ARN: z.string().optional(),
  // Database setup only: the IAM database user of fn-moonshot-billing.
  BILLING_DATABASE_USER: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default("billing_fn"),
  AWS_REGION: z.string().optional(),
  AWS_ROLE_ARN: z.string().optional(),
  AWS_FEDERATION_RESOURCE: z.string().optional(),
  COSMOS_CONNECTION_STRING: z.string().min(1).optional(),
  COSMOS_ENDPOINT: z.string().url().optional(),
  COSMOS_DATABASE: z.string().default("moonshot"),
}).refine(env => Boolean(env.COSMOS_CONNECTION_STRING) !== Boolean(env.COSMOS_ENDPOINT), {
  message: "Set COSMOS_CONNECTION_STRING for the local emulator or COSMOS_ENDPOINT for Microsoft Entra sign-in, not both.",
}).refine(env => env.DATABASE_AUTH !== "aws-iam" || (env.AWS_REGION && env.AWS_ROLE_ARN && env.AWS_FEDERATION_RESOURCE), {
  message: "DATABASE_AUTH=aws-iam requires AWS_REGION, AWS_ROLE_ARN and AWS_FEDERATION_RESOURCE.",
});

export const cacheSettings = z.object({
  REDIS_URL: z.string().min(1),
  REDIS_AUTH: z.enum(["password", "entra"]).default("password"),
});

type StorageSettings = z.infer<typeof storageSettings>;

let credential: DefaultAzureCredential | undefined;
const azureCredential = () => (credential ??= new DefaultAzureCredential());

let awsSession: Promise<AwsCredentialIdentity> | undefined;

/** AWS credentials for AWS_ROLE_ARN, obtained with the managed identity's Entra token and reused until near expiry. */
export function awsCredentials(settings: StorageSettings): () => Promise<AwsCredentialIdentity> {
  const sts = new STSClient({ region: settings.AWS_REGION });
  const refresh = async (): Promise<AwsCredentialIdentity> => {
    const { token } = await azureCredential().getToken(`${settings.AWS_FEDERATION_RESOURCE}/.default`);
    let result;
    try {
      result = await sts.send(new AssumeRoleWithWebIdentityCommand({
        RoleArn: settings.AWS_ROLE_ARN,
        RoleSessionName: "data-platform-api",
        WebIdentityToken: token,
        DurationSeconds: 3600,
      }));
    } catch (error) {
      // Name the token's issuer and audience (never the token) so a trust mismatch is easy to fix.
      const { iss, aud, oaud, ver, sub } = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
      throw new Error(`AWS STS rejected the managed identity token (iss=${iss}, aud=${aud}, oaud=${oaud}, ver=${ver}, sub=${sub}).`, { cause: error });
    }
    const c = result.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error("AWS STS returned no credentials.");
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
  };
  return async () => {
    const current = awsSession && (await awsSession.catch(() => undefined));
    if (!current?.expiration || current.expiration.getTime() - Date.now() < 5 * 60_000) awsSession = refresh();
    return awsSession!;
  };
}

function databaseCa(settings: StorageSettings): string | undefined {
  return settings.DATABASE_CA_FILE ? readFileSync(settings.DATABASE_CA_FILE, "utf8") : undefined;
}

export function openInventory(settings: StorageSettings, maxConnections: number): InventoryStore {
  let password: (() => Promise<string>) | undefined;
  if (settings.DATABASE_AUTH === "entra") {
    password = async () => (await azureCredential().getToken("https://ossrdbms-aad.database.windows.net/.default")).token;
  } else if (settings.DATABASE_AUTH === "aws-iam") {
    const url = new URL(settings.DATABASE_URL);
    const signer = new Signer({
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      username: decodeURIComponent(url.username),
      region: settings.AWS_REGION!,
      credentials: awsCredentials(settings),
    });
    password = () => signer.getAuthToken();
  }
  return new InventoryStore(settings.DATABASE_URL, maxConnections, password, databaseCa(settings));
}

/**
 * Amazon RDS only (database setup, never API startup): creates the IAM-authenticated database users,
 * signing in once as the RDS-managed administrator, whose password lives in AWS Secrets Manager and is
 * never stored here. Skipped when both users are ready.
 *  - DATABASE_URL's user (the API) may create tables in `public` for its migrations.
 *  - BILLING_DATABASE_USER (fn-moonshot-billing) may create its own `billing` schema; it is not granted
 *    anything in `public`, and the API gets nothing in `billing`.
 * The administrator is never made a member of these users: membership pulls it into rds_iam and
 * disables its password. Older setup code did that, so this revokes it and, until it is revoked, signs
 * the administrator in with an IAM token instead (the API's AWS role may connect as the administrator).
 */
export async function prepareDatabaseUsers(settings: StorageSettings): Promise<void> {
  if (settings.DATABASE_AUTH !== "aws-iam" || !settings.DATABASE_ADMIN_SECRET_ARN) return;
  if (await databaseUsersReady(settings)) return;
  const secrets = new SecretsManagerClient({ region: settings.AWS_REGION, credentials: awsCredentials(settings) });
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: settings.DATABASE_ADMIN_SECRET_ARN }));
  const admin = JSON.parse(SecretString ?? "{}") as { username?: string; password?: string };
  if (!admin.username || !admin.password) throw new Error("The RDS administrator secret has no username or password.");

  const url = new URL(settings.DATABASE_URL);
  const apiUser = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  url.username = encodeURIComponent(admin.username);
  const client = await connectAsAdministrator(settings, url, admin.password);
  try {
    const db = client.escapeIdentifier(database);
    for (const user of [apiUser, settings.BILLING_DATABASE_USER]) {
      const role = client.escapeIdentifier(user);
      await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${client.escapeLiteral(user)}) THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
      await client.query(`GRANT rds_iam TO ${role}`);
      await client.query(`DO $$ BEGIN IF pg_has_role(current_user, ${client.escapeLiteral(user)}, 'USAGE') THEN REVOKE ${role} FROM CURRENT_USER; END IF; END $$`);
    }
    const api = client.escapeIdentifier(apiUser);
    await client.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${api}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${api}`);
    await client.query(`GRANT CONNECT, CREATE ON DATABASE ${db} TO ${client.escapeIdentifier(settings.BILLING_DATABASE_USER)}`);
  } finally {
    await client.end();
  }
}

/** Password first; an IAM token if the administrator was pulled into rds_iam by older setup code. */
async function connectAsAdministrator(settings: StorageSettings, url: URL, password: string): Promise<pg.Client> {
  const withPassword = new pg.Client(poolConfig(url.toString(), 1, async () => password, databaseCa(settings)));
  try {
    await withPassword.connect();
    return withPassword;
  } catch (error) {
    if ((error as { code?: string }).code !== "28000" && (error as { code?: string }).code !== "28P01") throw error;
  }
  const signer = new Signer({
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    username: decodeURIComponent(url.username),
    region: settings.AWS_REGION!,
    credentials: awsCredentials(settings),
  });
  const withToken = new pg.Client(poolConfig(url.toString(), 1, () => signer.getAuthToken(), databaseCa(settings)));
  await withToken.connect();
  return withToken;
}

async function databaseUsersReady(settings: StorageSettings): Promise<boolean> {
  const store = openInventory(settings, 1);
  try {
    return await store.canCreateTables() && await store.roleExists(settings.BILLING_DATABASE_USER);
  } catch {
    return false;
  } finally {
    await store.close();
  }
}
export function openCatalog(settings: StorageSettings, options: { create?: boolean } = {}): Promise<CatalogStore> {
  const account = settings.COSMOS_ENDPOINT
    ? { endpoint: settings.COSMOS_ENDPOINT, credential: azureCredential() }
    : { connectionString: settings.COSMOS_CONNECTION_STRING! };
  return CatalogStore.connect(account, settings.COSMOS_DATABASE, options);
}

export function redisCredentials(settings: z.infer<typeof cacheSettings>) {
  if (settings.REDIS_AUTH !== "entra") return undefined;
  return EntraIdCredentialsProviderFactory.createForDefaultAzureCredential({
    credential: azureCredential(),
    scopes: ["https://redis.azure.com/.default"],
    tokenManagerConfig: { expirationRefreshRatio: 0.8 },
  });
}