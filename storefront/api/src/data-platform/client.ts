import createClient from "openapi-fetch";
import type { ApiError, ReservationRequest } from "../types.ts";
import type { paths } from "./contract.ts";

export class UpstreamError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unavailable = () =>
  new UpstreamError(503, "SERVICE_UNAVAILABLE", "Tickets are temporarily unavailable. Please try again in a moment.");

type Result<T> = { data?: T; error?: unknown; response: Response };

function unwrap<T>(result: Result<T>): T {
  if (result.data !== undefined) return result.data;
  const status = result.response.status;
  const body = result.error as Partial<ApiError> | undefined;
  if (status >= 400 && status < 500 && body?.code && body.message) {
    throw new UpstreamError(status, body.code, body.message);
  }
  throw unavailable();
}

async function call<T>(request: () => Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await request();
  } catch {
    throw unavailable();
  }
  return unwrap(result);
}

export function createDataPlatformClient(baseUrl: string, timeoutMs = 3000) {
  const client = createClient<paths>({
    baseUrl,
    fetch: request => fetch(request, { signal: AbortSignal.timeout(request.method === "POST" ? timeoutMs * 3 : timeoutMs) }),
  });

  return {
    festival: () => call(() => client.GET("/v1/festival")),
    offers: () => call(() => client.GET("/v1/offers")),
    offer: (offerId: string) => call(() => client.GET("/v1/offers/{offerId}", { params: { path: { offerId } } })),
    liveAvailability: (offerId: string) =>
      call(() => client.GET("/v1/offers/{offerId}/availability", { params: { path: { offerId }, query: { freshness: "live" } } })),
    reserve: (body: ReservationRequest, idempotencyKey: string) =>
      call(() => client.POST("/v1/reservations", { body, params: { header: { "Idempotency-Key": idempotencyKey } } })),
    reservation: (confirmationCode: string, accessKey: string) =>
      call(() => client.GET("/v1/reservations/{confirmationCode}", {
        params: { path: { confirmationCode }, header: { "X-Reservation-Access-Key": accessKey } },
      })),
    ready: async () => {
      const response = await fetch(new URL("/health/ready", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    },
  };
}

export type DataPlatformClient = ReturnType<typeof createDataPlatformClient>;
