import { useEffect, useState } from "react";
import type { ApiError } from "../../api/src/types.ts";

export type { Festival, Invoice, Offer, Reservation, Money } from "../../api/src/types.ts";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new RequestError(0, "NETWORK_ERROR", "We couldn't reach Moonshot Fest. Check your connection and try again.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
    throw new RequestError(response.status, body?.code ?? "UNKNOWN", body?.message ?? "Something went wrong. Please try again.");
  }
  return (await response.json()) as T;
}

export function useResource<T>(path: string, options: { headers?: Record<string, string>; refreshMs?: number } = {}) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const headerKey = JSON.stringify(options.headers ?? {});

  useEffect(() => {
    let active = true;
    if (!path) {
      setData(undefined);
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        const result = await api<T>(path, { headers: JSON.parse(headerKey) as Record<string, string> });
        if (active) {
          setData(result);
          setError(undefined);
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Something went wrong.");
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = options.refreshMs ? window.setInterval(() => void load(), options.refreshMs) : undefined;
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [path, headerKey, options.refreshMs, attempt]);

  return { data, error, loading, retry: () => setAttempt(value => value + 1) };
}

export const randomToken = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
