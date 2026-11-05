import { useEffect, useState } from "react";
import type { Money, Offer } from "./api.ts";

export const money = ({ amountMinor, currency }: Money) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: amountMinor % 100 ? 2 : 0 }).format(amountMinor / 100);

export const longDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const dateTime = (value: string) =>
  `${new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;

export const clockTime = (value: string) =>
  new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function Countdown({ until, label }: { until: string; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  const parts = [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60];
  return (
    <div className="countdown" role="timer" aria-label={label}>
      {parts.map((value, index) => (
        <div key={index}>
          <strong>{String(value).padStart(2, "0")}</strong>
          <span>{["DAYS", "HOURS", "MIN", "SEC"][index]}</span>
        </div>
      ))}
    </div>
  );
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
  return loading ? <div className="notice" role="status">Loading…</div> : null;
}

export function Moon() {
  return (
    <div className="moon-scene" aria-hidden="true">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="moon"><i /><i /><i /><i /><i /></div>
      <div className="moon-label">43.31 S / 11.36 W<br />TYCHO CRATER</div>
    </div>
  );
}

export const includesLabel = (offer: Pick<Offer, "access" | "includesShuttle">) =>
  offer.access === null ? "Shuttle only" : offer.includesShuttle ? "Festival + shuttle" : "Festival only";

function AvailabilityLine({ offer }: { offer: Offer }) {
  const { availability } = offer;
  switch (availability.saleStatus) {
    case "UPCOMING": return <>On sale {dateTime(offer.salesOpenAt)}</>;
    case "ENDED": return <>Sales have closed</>;
    case "SOLD_OUT": return <>Sold out</>;
  }
  if (offer.availabilityWarning) {
    return <span className="warning">{availability.remaining} left as of {clockTime(availability.asOf)} · couldn't refresh live count</span>;
  }
  if (availability.freshness === "LIVE") {
    return <><span className="status-dot" /> {availability.remaining} of these left · live</>;
  }
  if (availability.remaining <= 25) return <>Only {availability.remaining} left</>;
  return <>Available</>;
}

export function OfferCard({ offer }: { offer: Offer }) {
  const drop = offer.saleType === "LIMITED_DROP";
  const onSale = offer.availability.saleStatus === "ON_SALE";
  return (
    <article className={`offer-card ${drop ? "exclusive" : ""}`}>
      <div className="card-top">
        <span className={`badge ${drop ? "purple" : ""}`}>
          {drop ? "Exclusive drop" : offer.access === "VIP" ? "VIP" : offer.access === "GENERAL" ? "General admission" : "Shuttle"}
        </span>
        {offer.limitedAvailability && !drop && <span className="badge">Limited availability</span>}
        <span className="day-label">DAY {offer.day}</span>
      </div>
      <h3>{offer.name}</h3>
      <p className="description">{offer.description}</p>
      <ul className="features">
        {offer.perks.map(perk => <li key={perk}><span>✓</span>{perk}</li>)}
      </ul>
      <div className="availability"><AvailabilityLine offer={offer} /></div>
      <div className="card-bottom">
        <div><strong>{money(offer.unitPrice)}</strong><span> / pass</span></div>
        {onSale
          ? <a className={`button small ${drop ? "primary" : "outline"}`} href={`/reserve/${encodeURIComponent(offer.offerId)}`}>Reserve ↗</a>
          : <button className="button small outline" disabled>{offer.availability.saleStatus === "UPCOMING" ? "Coming soon" : "Unavailable"}</button>}
      </div>
    </article>
  );
}
