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

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(20270820);
const stars = Array.from({ length: 140 }, () => ({
  x: random() * 1440, y: random() * 640, r: 0.5 + random() * 1.3, o: 0.25 + random() * 0.7,
}));

export function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 1440 900" preserveAspectRatio="xMaxYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e2dfd8" />
          <stop offset="0.5" stopColor="#b6b2ab" />
          <stop offset="1" stopColor="#6f6c69" />
        </linearGradient>
        <linearGradient id="beam" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#f4c452" stopOpacity="0.5" />
          <stop offset="1" stopColor="#f4c452" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="earth" cx="0.38" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#bfe0ff" />
          <stop offset="0.45" stopColor="#5b9bf0" />
          <stop offset="1" stopColor="#1d4aa6" />
        </radialGradient>
        <linearGradient id="night" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0.45" stopColor="#0b1430" stopOpacity="0" />
          <stop offset="0.85" stopColor="#0b1430" stopOpacity="0.85" />
        </linearGradient>
        <clipPath id="globe"><circle cx="0" cy="0" r="150" /></clipPath>
      </defs>
      {stars.map((star, index) => <circle key={index} cx={star.x} cy={star.y} r={star.r} fill="#fff" opacity={star.o} />)}
      <g transform="translate(1150 610) scale(1.3)">
        <g className="earth">
          <circle r="158" fill="#7db2ff" opacity="0.16" />
          <circle r="150" fill="url(#earth)" />
          <g clipPath="url(#globe)" fill="#fff" opacity="0.6">
            <ellipse cx="-58" cy="-64" rx="58" ry="12" transform="rotate(-14 -58 -64)" />
            <ellipse cx="22" cy="2" rx="76" ry="10" transform="rotate(8 22 2)" />
            <ellipse cx="-34" cy="62" rx="50" ry="9" transform="rotate(-6 -34 62)" />
            <ellipse cx="64" cy="-60" rx="32" ry="7" />
          </g>
          <circle r="150" fill="url(#night)" />
        </g>
      </g>
      <g opacity="0.75">
        <polygon points="1122,690 1138,690 860,40 960,40" fill="url(#beam)" />
        <polygon points="1144,690 1156,690 1110,0 1190,0" fill="url(#beam)" />
        <polygon points="1162,690 1178,690 1340,40 1440,40" fill="url(#beam)" />
      </g>
      <path d="M0 790 C 300 760 640 732 900 714 C 1100 700 1280 694 1440 682 L1440 900 L0 900 Z" fill="url(#ground)" />
      <g fill="#8d8a85" opacity="0.55">
        <ellipse cx="260" cy="836" rx="96" ry="14" />
        <ellipse cx="760" cy="790" rx="64" ry="10" />
        <ellipse cx="1320" cy="832" rx="110" ry="17" />
        <ellipse cx="560" cy="872" rx="70" ry="11" />
      </g>
      <path d="M1066 706 C 1078 640 1222 640 1234 706 Z" fill="#1d2647" />
      <path d="M1084 704 C 1094 660 1206 660 1216 704 Z" fill="#33406e" />
      <rect x="1058" y="702" width="184" height="10" rx="2" fill="#1d2647" />
    </svg>
  );
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
