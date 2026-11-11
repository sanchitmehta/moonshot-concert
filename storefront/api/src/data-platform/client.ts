import createClient from "openapi-fetch";
import type { ApiError, ReservationRequest } from "../types.ts";
import type { paths } from "./contract.ts";

type UpstreamResponse = { status: number; code?: string };

export class UpstreamError extends Error {
  readonly status: number;
  readonly code: string;
  /** What the data-platform-api answered; unset when it did not answer. */
  readonly upstream?: UpstreamResponse;

  constructor(status: number, code: string, message: string, cause?: unknown, upstream?: UpstreamResponse) {
    super(message, { cause });
    this.status = status;
    this.code = code;
    this.upstream = upstream;
  }
}

const unavailable = (cause: unknown, upstream?: UpstreamResponse) =>
  new UpstreamError(503, "SERVICE_UNAVAILABLE", "Tickets are temporarily unavailable. Please try again in a moment.", cause, upstream);

type Result<T> = { data?: T; error?: unknown; response: Response };

function unwrap<T>(result: Result<T>): T {
  if (result.data !== undefined) return result.data;
  const status = result.response.status;
  const body = result.error as Partial<ApiError> | undefined;
  const upstream = { status, code: body?.code };
  if (status >= 400 && status < 500 && body?.code && body.message) {
    throw new UpstreamError(status, body.code, body.message, undefined, upstream);
  }
  throw unavailable(new Error(`Data platform responded ${status}${body?.code ? ` ${body.code}` : ""}`), upstream);
}

async function call<T>(request: () => Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await request();
  } catch (error) {
    throw unavailable(error);
  }
  return unwrap(result);
}

/** `accessToken` returns a bearer token for the data-platform-api; omitted locally, where it runs without sign-in. */
export function createDataPlatformClient(baseUrl: string, options: { timeoutMs?: number; accessToken?: () => Promise<string> } = {}) {
  const { timeoutMs = 3000, accessToken } = options;
  const client = createClient<paths>({
    baseUrl,
    fetch: async request => {
      if (accessToken) request.headers.set("authorization", `Bearer ${await accessToken()}`);
      return fetch(request, { signal: AbortSignal.timeout(request.method === "POST" ? timeoutMs * 3 : timeoutMs) });
    },
  });

  return {
    festival: () => call(() => client.GET("/v1/festival")),
    offers: () => call(() => client.GET("/v1/offers")),
    offer: (offerId: string) => call(() => client.GET("/v1/offers/{offerId}", { params: { path: { offerId } } })),
    liveAvailability: (offerId: string) =>
      call(() => client.GET("/v1/offers/{offerId}/availability", { params: { path: { offerId }, query: { freshness: "live" } } })),
    reserve: (body: ReservationRequest, idempotencyKey: string) =>
      call(() => client.POST("/v1/reservations", { body, params: { header: { "Idempotency-Key": idempotencyKey } } })),
    joinQueue: (queue: string, offerId: string, guestKey: string) =>
      call(() => client.POST("/v1/queues/{queue}/entries", { params: { path: { queue } }, body: { offerId, guestKey } })),
    queueEntry: (queue: string, entryId: string, guestKey: string) =>
      call(() => client.GET("/v1/queues/{queue}/entries/{entryId}", {
        params: { path: { queue, entryId }, header: { "X-Guest-Key": guestKey } },
      })),
    admit: (queue: string, count: number, idempotencyKey: string) =>
      call(() => client.POST("/v1/queues/{queue}/admissions", {
        params: { path: { queue }, header: { "Idempotency-Key": idempotencyKey } }, body: { count },
      })),
    reservation: (confirmationCode: string, accessKey: string) =>
      call(() => client.GET("/v1/reservations/{confirmationCode}", {
        params: { path: { confirmationCode }, header: { "X-Reservation-Access-Key": accessKey } },
      })),    invoice: (confirmationCode: string, accessKey: string) =>
      call(() => client.GET("/v1/reservations/{confirmationCode}/invoice", {
        params: { path: { confirmationCode }, header: { "X-Reservation-Access-Key": accessKey } },
      })),
    ready: async () => {
      const response = await fetch(new URL("/health/ready", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok;
    },
  };
}

export type DataPlatformClient = ReturnType<typeof createDataPlatformClient>;
