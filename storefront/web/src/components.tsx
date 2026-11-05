import { useEffect, useState } from "react";
import type { Festival, Money, Offer } from "./api.ts";

export const money = ({ amountMinor, currency }: Money) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: amountMinor % 100 ? 2 : 0 }).format(amountMinor / 100);

const utc = (options: Intl.DateTimeFormatOptions) => (value: string) =>
  new Date(value).toLocaleString("en-US", { ...options, timeZone: "UTC" });

export const dayName = utc({ weekday: "long" });
export const shortDate = utc({ weekday: "short", day: "numeric", month: "short" });
export const longDate = utc({ day: "numeric", month: "long", year: "numeric" });
export const longDayDate = utc({ day: "numeric", month: "long" });
export const monthDay = utc({ month: "short", day: "numeric" });
export const clock = (value: string) => new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
export const saleOpens = (value: string) => `${utc({ day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })(value)} UTC`;
const localClock = (value: string) => new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const festivalDates = (festival: Festival) => {
  const first = festival.days[0]!.date;
  const last = festival.days[festival.days.length - 1]!.date;
  const month = utc({ month: "long" })(first);
  return `${Number(first.slice(8))}–${Number(last.slice(8))} ${month} ${first.slice(0, 4)}`;
};

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function TimeUntil({ until }: { until: string }) {
  const now = useNow();
  const seconds = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  const days = Math.floor(seconds / 86400);
  const rest = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0"))
    .join(":");
  return <strong>{days} {days === 1 ? "day" : "days"}, {rest}</strong>;
}

export function Status({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  if (error) {
    return (
      <div className="notice error" role="alert">
        <span>{error}</span>
        <button className="text-button" onClick={retry}>Try again</button>
      </div>
    );
  }
  return loading ? <p className="notice" role="status">Loading</p> : null;
}

const typeRank = (offer: Offer) =>
  offer.saleType === "LIMITED_DROP" ? 4 : offer.access === null ? 5 : (offer.access === "VIP" ? 2 : 0) + (offer.includesShuttle ? 1 : 0);

export const sortOffers = (offers: Offer[]) => [...offers].sort((a, b) => a.day - b.day || typeRank(a) - typeRank(b));

export const includesSummary = (offer: Pick<Offer, "access" | "includesShuttle">) =>
  offer.access === null ? "Shuttle only" : offer.includesShuttle ? "Festival entry and shuttle" : "Festival entry";

export function Availability({ offer, tone = "light" }: { offer: Offer; tone?: "light" | "dark" }) {
  const { availability } = offer;
  switch (availability.saleStatus) {
    case "UPCOMING": return <span className="availability muted">On sale {saleOpens(offer.salesOpenAt)}</span>;
    case "ENDED": return <span className="availability muted">Sales closed</span>;
    case "SOLD_OUT": return <span className="availability muted">Sold out</span>;
  }
  if (offer.availabilityWarning) {
    return (
      <span className="availability warning">
        {availability.remaining} left at {localClock(availability.asOf)}. Live count unavailable.
      </span>
    );
  }
  if (availability.freshness === "LIVE") {
    return <span className="availability"><span className="live-dot" />{availability.remaining} left right now</span>;
  }
  if (availability.remaining <= 25) return <span className="availability">Only {availability.remaining} left</span>;
  return <span className={`availability ${tone === "dark" ? "" : "muted"}`}>Available</span>;
}

export function Perks({ perks, className = "includes" }: { perks: string[]; className?: string }) {
  return (
    <ul className={className}>
      {perks.map(perk => <li key={perk} className={/not included/i.test(perk) ? "not-included" : undefined}>{perk}</li>)}
    </ul>
  );
}

export function ReserveLink({ offer, label = "Reserve" }: { offer: Offer; label?: string }) {
  if (offer.availability.saleStatus !== "ON_SALE") {
    return <button className="button button-small button-quiet" disabled>{offer.availability.saleStatus === "UPCOMING" ? "Coming soon" : "Unavailable"}</button>;
  }
  return (
    <a className="button button-small button-gold" href={`/reserve/${encodeURIComponent(offer.offerId)}`} aria-label={`${label} ${offer.name}`}>
      {label}
    </a>
  );
}
