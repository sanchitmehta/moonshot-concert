/** Reads a JSON value saved for this browser tab, or undefined when it is missing or unreadable. */
export function loadSession<T>(key: string): T | undefined {
  try {
    const stored = sessionStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Set when a reservation was confirmed on a later try, so the confirmation page can say so once. */
export const confirmedOnRetryKey = (confirmationCode: string) => `moonshot-fest:confirmed-on-retry:${confirmationCode}`;
