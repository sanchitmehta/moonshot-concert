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
  const [errorCode, setErrorCode] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const headerKey = JSON.stringify(options.headers ?? {});

  useEffect(() => {
    let active = true;
    if (!path) {
      setData(undefined);
      setError(undefined);
      setErrorCode(undefined);
      setLoading(false);
      return;
    }
    const load = async () => {
      try {
        const result = await api<T>(path, { headers: JSON.parse(headerKey) as Record<string, string> });
        if (active) {
          setData(result);
          setError(undefined);
          setErrorCode(undefined);
          setUpdatedAt(Date.now());
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Something went wrong.");
          setErrorCode(caught instanceof RequestError ? caught.code : "UNKNOWN");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    if (!options.refreshMs) return () => { active = false; };
    const timer = window.setInterval(() => void load(), options.refreshMs);
    // Browsers slow timers in background tabs, so catch up as soon as the page is looked at again.
    const catchUp = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [path, headerKey, options.refreshMs, attempt]);

  /** `data` keeps the last good response while `error` is set; `updatedAt` is when that response arrived. */
  return { data, error, errorCode, updatedAt, loading, retry: () => setAttempt(value => value + 1) };
}

export const randomToken = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
