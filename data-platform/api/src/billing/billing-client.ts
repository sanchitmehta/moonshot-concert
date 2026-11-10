import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { Money } from "../domain.ts";
import { ServiceError } from "../errors.ts";

// The event and response shapes of fn-moonshot-billing (data-platform/billing/src/handler.ts).
export type ChargeRequest = {
  reservationId: string;
  walletId: string;
  billedTo: string;
  lines: { description: string; quantity: number; unitPrice: Money }[];
};

export type Charge = {
  paymentId: string;
  invoiceNumber: string;
  walletLast4: string;
  amount: Money;
  balanceAfter: Money;
  paidAt: string;
};

export type Invoice = {
  invoiceNumber: string;
  issuedAt: string;
  reservationId: string;
  billedTo: string;
  lines: { description: string; quantity: number; unitPrice: Money; amount: Money }[];
  total: Money;
  payment: { method: "MOONSHOT_WALLET"; paymentId: string; walletLast4: string; paidAt: string };
};

type BillingResponse<T> = { ok: true; result: T } | { ok: false; error: { status: number; code: string; message: string } };

/**
 * Moonshot Billing. A refusal (invalid wallet, insufficient funds) throws a 4xx ServiceError the
 * guest can act on; anything else throws 503 BILLING_UNAVAILABLE, and the charge is safe to retry.
 */
export interface BillingClient {
  charge(request: ChargeRequest): Promise<Charge>;
  invoice(invoiceNumber: string): Promise<Invoice>;
}

const unavailable = (cause?: unknown) =>
  Object.assign(new ServiceError(503, "BILLING_UNAVAILABLE", "Payment is unavailable right now. Try again: retrying won't charge you twice."), { cause });

type Transport = (event: object) => Promise<BillingResponse<unknown>>;

function client(transport: Transport): BillingClient {
  const call = async <T>(event: object): Promise<T> => {
    let response: BillingResponse<unknown>;
    try {
      response = await transport(event);
    } catch (error) {
      throw unavailable(error);
    }
    if (!response.ok) {
      if (response.error.status >= 500) throw unavailable(response.error);
      throw new ServiceError(response.error.status, response.error.code, response.error.message);
    }
    return response.result as T;
  };
  return {
    charge: request => call<Charge>({ action: "charge", ...request }),
    invoice: invoiceNumber => call<Invoice>({ action: "getInvoice", invoiceNumber }),
  };
}

/** In AWS: invokes the Lambda function directly with the API's AWS role (lambda:InvokeFunction). */
export function lambdaBillingClient(functionName: string, region: string, credentials: AwsCredentialIdentityProvider): BillingClient {
  const lambda = new LambdaClient({ region, credentials, maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, requestTimeout: 15_000 } });
  return client(async event => {
    const output = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify(event)) }));
    const payload = output.Payload ? Buffer.from(output.Payload).toString("utf8") : "";
    if (output.FunctionError) throw new Error(`${functionName} failed: ${output.FunctionError} ${payload.slice(0, 500)}`);
    return JSON.parse(payload) as BillingResponse<unknown>;
  });
}

/** Locally: the billing service's development server (data-platform/billing/src/local-server.ts). */
export function httpBillingClient(baseUrl: string): BillingClient {
  return client(async event => {
    const response = await fetch(new URL("/invoke", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Billing returned ${response.status}`);
    return (await response.json()) as BillingResponse<unknown>;
  });
}
