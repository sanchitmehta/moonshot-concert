import { useState, type FormEvent } from "react";
import { includesLabel, money, Status } from "../components.tsx";
import { api, randomToken, RequestError, useResource, type Money, type Offer, type Reservation } from "../api.ts";

type Attempt = { idempotencyKey: string; accessKey: string; leadName: string; quantity: number; expectedUnitPrice: Money };

const storageKey = (offerId: string) => `moonshot-fest:reservation:${offerId}`;

function loadAttempt(offerId: string): Attempt | undefined {
  try {
    const stored = sessionStorage.getItem(storageKey(offerId));
    return stored ? (JSON.parse(stored) as Attempt) : undefined;
  } catch {
    return undefined;
  }
}

export function Reserve({ offerId }: { offerId: string }) {
  const offer = useResource<Offer>(`/offers/${encodeURIComponent(offerId)}`);
  const [attempt, setAttempt] = useState(() => loadAttempt(offerId));
  const [leadName, setLeadName] = useState(attempt?.leadName ?? "");
  const [quantity, setQuantity] = useState(attempt?.quantity ?? 1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const pass = offer.data;
  const unitPrice = attempt?.expectedUnitPrice ?? pass?.unitPrice;
  const maxQuantity = pass ? Math.max(1, Math.min(pass.maxPerReservation, pass.availability.remaining)) : 1;

  const clearAttempt = () => {
    sessionStorage.removeItem(storageKey(offerId));
    setAttempt(undefined);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pass || submitting) return;
    const current: Attempt = attempt ?? {
      idempotencyKey: randomToken(16),
      accessKey: randomToken(32),
      leadName: leadName.trim(),
      quantity,
      expectedUnitPrice: pass.unitPrice,
    };
    sessionStorage.setItem(storageKey(offerId), JSON.stringify(current));
    setAttempt(current);
    setSubmitting(true);
    setError(undefined);
    try {
      const reservation = await api<Reservation>("/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": current.idempotencyKey },
        body: JSON.stringify({
          offerId, leadName: current.leadName, quantity: current.quantity,
          expectedUnitPrice: current.expectedUnitPrice, accessKey: current.accessKey,
        }),
      });
      clearAttempt();
      window.location.assign(`/confirmation/${encodeURIComponent(reservation.confirmationCode)}#key=${current.accessKey}`);
    } catch (caught) {
      const failure = caught instanceof RequestError ? caught : new RequestError(0, "UNKNOWN", "Something went wrong.");
      if (failure.status > 0 && failure.status < 500) {
        clearAttempt();
        setError(failure.message);
        if (failure.code === "PRICE_CHANGED" || failure.code === "INSUFFICIENT_STOCK") offer.retry();
      } else {
        setError("We couldn't confirm your reservation yet. Try again: retrying won't reserve twice.");
      }
      setSubmitting(false);
    }
  }

  return (
    <section className="section page-section">
      <a className="back-link" href="/passes">← All passes</a>
      <p className="eyebrow">RESERVE</p>
      <h1 className="page-title">Make it <em>happen.</em></h1>
      <Status {...offer} />

      {pass && unitPrice && (
        <div className="booking-layout">
          <div className="booking-story">
            <span className="badge purple">DAY {pass.day} · {includesLabel(pass).toUpperCase()}</span>
            <h2>{pass.name}</h2>
            <p>{pass.description}</p>
            <ul className="features">{pass.perks.map(perk => <li key={perk}>✓ {perk}</li>)}</ul>
            <div className="booking-orbit" aria-hidden="true">☾</div>
          </div>

          <form className="booking-form" onSubmit={submit}>
            <h3>Your reservation</h3>
            <p className="muted">No account needed. One name covers every pass in this reservation.</p>

            <label htmlFor="lead-name">NAME ON THE PASS</label>
            <input
              id="lead-name" type="text" autoComplete="name" maxLength={80} required
              value={attempt?.leadName ?? leadName} disabled={!!attempt || submitting}
              onChange={event => setLeadName(event.target.value)}
            />

            <label htmlFor="quantity">PASSES</label>
            <select
              id="quantity" value={attempt?.quantity ?? quantity} disabled={!!attempt || submitting}
              onChange={event => setQuantity(Number(event.target.value))}
            >
              {Array.from({ length: maxQuantity }, (_, index) => index + 1).map(count => (
                <option key={count} value={count}>{count} {count === 1 ? "pass" : "passes"}</option>
              ))}
            </select>

            <div className="price-line"><span>{money(unitPrice)} × {attempt?.quantity ?? quantity}</span></div>
            <div className="price-line total">
              <span>Total</span>
              <strong>{money({ ...unitPrice, amountMinor: unitPrice.amountMinor * (attempt?.quantity ?? quantity) })}</strong>
            </div>

            {error && <div className="notice error" role="alert">{error}</div>}

            {pass.availability.saleStatus === "ON_SALE" || attempt ? (
              <button className="button primary full" disabled={submitting || (!attempt && !leadName.trim())}>
                {submitting ? "Confirming…" : attempt ? "Try again ↗" : "Confirm reservation ↗"}
              </button>
            ) : (
              <p className="notice" role="status">This pass isn't on sale right now.</p>
            )}
            {attempt && !submitting && (
              <button type="button" className="text-button" onClick={clearAttempt}>Start a new reservation instead</button>
            )}
            <p className="small-note">Price and availability are confirmed when you reserve.</p>
          </form>
        </div>
      )}
    </section>
  );
}
