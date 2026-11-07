import { useEffect, useState, type FormEvent } from "react";
import { Availability, dayName, includesSummary, money, Perks, Status } from "../components.tsx";
import { api, randomToken, RequestError, useResource, type Money, type Offer, type Reservation } from "../api.ts";

type Attempt = {
  idempotencyKey: string;
  accessKey: string;
  leadName: string;
  quantity: number;
  walletId: string;
  expectedUnitPrice: Money;
};

type PlaceInLine = {
  offerId: string;
  status: "WAITING" | "ADMITTED" | "EXPIRED" | "USED";
  position: number | null;
  estimatedWaitMinutes: number | null;
  admissionExpiresAt?: string;
};

const attemptKey = (offerId: string) => `moonshot-fest:reservation:${offerId}`;
const lineKey = (offerId: string) => `moonshot-fest:line:${offerId}`;

function load<T>(key: string): T | undefined {
  try {
    const stored = sessionStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Moonshot Wallet IDs look like MSW-1234-5678; the last digit is a Luhn check digit. */
export function walletIdValid(input: string): boolean {
  const match = /^MSW-(\d{4})-(\d{4})$/.exec(input.trim().toUpperCase());
  if (!match) return false;
  const digits = match[1]! + match[2]!;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function formatWalletId(input: string): string {
  const digits = input.toUpperCase().replace(/^MSW-?/, "").replace(/\D/g, "").slice(0, 8);
  return digits.length === 0 ? "" : `MSW-${digits.slice(0, 4)}${digits.length > 4 ? `-${digits.slice(4)}` : ""}`;
}

function waitText(minutes: number | null): string {
  if (minutes === null) return "We're moving guests through the line.";
  if (minutes <= 1) return "You're almost there.";
  if (minutes < 60) return `About ${minutes} minutes to go.`;
  const hours = Math.round(minutes / 60);
  return `About ${hours} ${hours === 1 ? "hour" : "hours"} to go.`;
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</>;
}

function WaitingRoom({ place, onLeave }: { place: PlaceInLine; onLeave: () => void }) {
  return (
    <div className="form-card queue-card" role="status" aria-live="polite">
      <p className="queue-label">You're in line</p>
      <p className="queue-position">#{place.position?.toLocaleString("en-US") ?? "…"}</p>
      <p>{waitText(place.estimatedWaitMinutes)}</p>
      <p className="fine-print">Passes are released in turns. Keep this page open: your place is saved, and the reserve form opens when it's your turn.</p>
      <button type="button" className="text-button" onClick={onLeave}>Leave the line</button>
    </div>
  );
}

export function Reserve({ offerId }: { offerId: string }) {
  const offer = useResource<Offer>(`/offers/${encodeURIComponent(offerId)}`);
  const [ticket, setTicket] = useState(() => load<string>(lineKey(offerId)));
  const line = useResource<PlaceInLine>(ticket ? `/waiting-room/${ticket}` : "", { refreshMs: ticket ? 5000 : undefined });
  const [attempt, setAttempt] = useState(() => load<Attempt>(attemptKey(offerId)));
  const [leadName, setLeadName] = useState(attempt?.leadName ?? "");
  const [quantity, setQuantity] = useState(attempt?.quantity ?? 1);
  const [walletId, setWalletId] = useState(attempt?.walletId ?? "");
  const [joining, setJoining] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const pass = offer.data;
  const place = ticket ? line.data : undefined;
  const unitPrice = attempt?.expectedUnitPrice ?? pass?.unitPrice;
  const count = attempt?.quantity ?? quantity;
  const maxQuantity = pass ? Math.max(1, Math.min(pass.maxPerReservation, pass.availability.remaining)) : 1;
  const onSale = pass?.availability.saleStatus === "ON_SALE";
  const walletReady = walletIdValid(attempt?.walletId ?? walletId);
  const total = unitPrice ? money({ ...unitPrice, amountMinor: unitPrice.amountMinor * count }) : "";

  const clearAttempt = () => {
    sessionStorage.removeItem(attemptKey(offerId));
    setAttempt(undefined);
  };
  const leaveLine = () => {
    sessionStorage.removeItem(lineKey(offerId));
    setTicket(undefined);
  };

  async function joinLine() {
    setJoining(true);
    setError(undefined);
    try {
      const joined = await api<PlaceInLine & { ticket: string }>("/waiting-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId }),
      });
      sessionStorage.setItem(lineKey(offerId), JSON.stringify(joined.ticket));
      setTicket(joined.ticket);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We couldn't add you to the line. Please try again.");
    } finally {
      setJoining(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!pass || !ticket || submitting) return;
    if (!walletReady) {
      setError("Check your Moonshot Wallet ID. It looks like MSW-1234-5678.");
      return;
    }
    const current: Attempt = attempt ?? {
      idempotencyKey: randomToken(16),
      accessKey: randomToken(32),
      leadName: leadName.trim(),
      quantity,
      walletId: walletId.trim().toUpperCase(),
      expectedUnitPrice: pass.unitPrice,
    };
    sessionStorage.setItem(attemptKey(offerId), JSON.stringify(current));
    setAttempt(current);
    setSubmitting(true);
    setError(undefined);
    try {
      const reservation = await api<Reservation>("/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": current.idempotencyKey },
        body: JSON.stringify({
          offerId, leadName: current.leadName, quantity: current.quantity, walletId: current.walletId,
          expectedUnitPrice: current.expectedUnitPrice, accessKey: current.accessKey, ticket,
        }),
      });
      clearAttempt();
      leaveLine();
      window.location.assign(`/confirmation/${encodeURIComponent(reservation.confirmationCode)}#key=${current.accessKey}`);
    } catch (caught) {
      const failure = caught instanceof RequestError ? caught : new RequestError(0, "UNKNOWN", "Something went wrong.");
      if (failure.status > 0 && failure.status < 500) {
        clearAttempt();
        setError(failure.message);
        if (["ADMISSION_EXPIRED", "ADMISSION_REQUIRED", "ADMISSION_USED", "ENTRY_NOT_FOUND"].includes(failure.code)) leaveLine();
        if (failure.code === "PRICE_CHANGED" || failure.code === "INSUFFICIENT_STOCK") offer.retry();
      } else {
        setError("Your reservation isn't confirmed yet. Try again: retrying won't charge you twice.");
      }
      setSubmitting(false);
    }
  }

  const admitted = place?.status === "ADMITTED" || (!!attempt && !!ticket);

  return (
    <main className="light page">
      <div className="wrap">
        <a className="back" href="/#passes">Back to passes</a>
        <Status {...offer} loading={offer.loading && !pass} />
        {pass && unitPrice && (
          <div className="reserve">
            <div className="reserve-intro">
              <p>Day {pass.day}, {dayName(pass.salesCloseAt)}. {includesSummary(pass)}.</p>
              <h1>{pass.name}</h1>
              <p>{pass.description}</p>
              <Perks perks={pass.perks} />
              <p style={{ marginTop: 24 }}><Availability offer={pass} /></p>
            </div>

            {!ticket && (
              <div className="form-card">
                <h2 className="queue-title">Join the line</h2>
                <p>Passes are released in turns to keep things fair. Join the line, and the reserve form opens when it's your turn.</p>
                {error && <div className="notice error" role="alert">{error}</div>}
                {onSale ? (
                  <button className="button button-gold button-block" onClick={() => void joinLine()} disabled={joining}>
                    {joining ? "Joining" : "Join the line"}
                  </button>
                ) : (
                  <p className="notice" role="status">This pass isn't on sale right now.</p>
                )}
              </div>
            )}

            {ticket && !place && <Status error={line.error} loading={line.loading} retry={line.retry} />}

            {ticket && place?.status === "WAITING" && !attempt && <WaitingRoom place={place} onLeave={leaveLine} />}

            {ticket && (place?.status === "EXPIRED" || (place?.status === "USED" && !attempt)) && (
              <div className="form-card">
                <h2 className="queue-title">{place.status === "EXPIRED" ? "Your turn has passed" : "Already reserved"}</h2>
                <p>{place.status === "EXPIRED"
                  ? "Your 10 minutes to reserve ran out. Join the line again to get a new turn."
                  : "This place in line was already used for a reservation."}</p>
                <button className="button button-gold button-block" onClick={() => { leaveLine(); void joinLine(); }}>Join the line again</button>
              </div>
            )}

            {admitted && (
              <form className="form-card" onSubmit={submit} aria-label={`Reserve ${pass.name}`}>
                {place?.admissionExpiresAt && (
                  <p className="turn-banner" role="status">It's your turn. <strong><Countdown until={place.admissionExpiresAt} /></strong> left to reserve.</p>
                )}
                <label className="field">
                  Name on the pass
                  <input
                    type="text" autoComplete="name" maxLength={80} required
                    value={attempt?.leadName ?? leadName} disabled={!!attempt || submitting}
                    onChange={event => setLeadName(event.target.value)}
                  />
                  <span className="hint">One name covers every pass in this reservation.</span>
                </label>

                <div className="field">
                  <span id="quantity-label">Number of passes</span>
                  <div className="stepper" role="group" aria-labelledby="quantity-label">
                    <button type="button" aria-label="One fewer pass" disabled={!!attempt || submitting || count <= 1} onClick={() => setQuantity(value => value - 1)}>−</button>
                    <output aria-live="polite">{count}</output>
                    <button type="button" aria-label="One more pass" disabled={!!attempt || submitting || count >= maxQuantity} onClick={() => setQuantity(value => value + 1)}>+</button>
                  </div>
                  <span className="hint">Up to {pass.maxPerReservation} per reservation.</span>
                </div>

                <label className="field">
                  Moonshot Wallet ID
                  <input
                    type="text" inputMode="numeric" autoComplete="off" placeholder="MSW-1234-5678" required
                    value={attempt?.walletId ?? walletId} disabled={!!attempt || submitting}
                    aria-invalid={walletId.length === 13 && !walletReady}
                    onChange={event => setWalletId(formatWalletId(event.target.value))}
                  />
                  <span className="hint">
                    {walletId.length === 13 && !walletReady
                      ? "That wallet ID doesn't look right. Check the number on your wallet."
                      : "From the wallet you collected at the Moonshot Earth Centre."}
                  </span>
                </label>

                <div className="total">
                  <span>{count} × {money(unitPrice)}</span>
                  <strong>{total}</strong>
                </div>

                {error && <div className="notice error" role="alert">{error}</div>}

                <button className="button button-gold button-block" disabled={submitting || (!attempt && (!leadName.trim() || !walletReady))}>
                  {submitting ? "Reserving" : attempt ? "Try again" : `Reserve and pay ${total}`}
                </button>
                {attempt && !submitting && (
                  <button type="button" className="text-button" onClick={clearAttempt}>Start a new reservation</button>
                )}
                <p className="fine-print">Price and availability are confirmed when you reserve. You pay from your Moonshot Wallet.</p>
              </form>
            )}
          </div>
        )}
      </div>
    </main>
  );
}