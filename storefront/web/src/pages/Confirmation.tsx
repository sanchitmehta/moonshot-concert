import { useState } from "react";
import { clock, dayName, includesSummary, longDate, money, Status } from "../components.tsx";
import { useResource, type Festival, type Reservation } from "../api.ts";

export function Confirmation({ confirmationCode }: { confirmationCode: string }) {
  const accessKey = new URLSearchParams(window.location.hash.slice(1)).get("key") ?? "";
  const reservation = useResource<Reservation>(`/reservations/${encodeURIComponent(confirmationCode)}`, {
    headers: { "X-Reservation-Access-Key": accessKey },
  });
  const festival = useResource<Festival>("/festival");
  const [copied, setCopied] = useState<string>();
  const data = reservation.data;
  const day = festival.data?.days.find(d => d.day === data?.pass.day);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("Link copied. Anyone with this link can see your reservation.");
    } catch {
      setCopied("Copy the address from your browser's address bar to keep this link.");
    }
  }

  return (
    <main className="page">
      <div className="wrap confirmation">
        {!accessKey && (
          <p className="notice error" role="alert">This link is missing its private key. Open the full link you saved when you reserved.</p>
        )}
        {accessKey && <Status {...reservation} loading={reservation.loading && !data} />}
        {data && (
          <>
            <h1>You're going to the Moon</h1>
            <p>Your passes are reserved. Keep this page's link: it's the only way to open your reservation.</p>
            <article className="ticket" aria-label="Your pass">
              <div className="ticket-main">
                <header>
                  <div>
                    <p>{day ? `${dayName(day.gatesOpenAt)}, ${longDate(day.gatesOpenAt)}, gates open ${clock(day.gatesOpenAt)} UTC` : `Moonshot Fest, day ${data.pass.day}`}</p>
                    <h2>{data.pass.name}</h2>
                  </div>
                  <span className="ticket-status">Reserved</span>
                </header>
                <dl className="ticket-grid">
                  <div><dt>Name</dt><dd>{data.leadName}</dd></div>
                  <div><dt>Passes</dt><dd>{data.quantity}</dd></div>
                  <div><dt>Includes</dt><dd>{includesSummary(data.pass)}</dd></div>
                  <div><dt>Total</dt><dd>{money(data.total)}</dd></div>
                </dl>
              </div>
              <div className="ticket-stub">
                <div>
                  <p className="fine-print">Confirmation code</p>
                  <p className="ticket-code">{data.confirmationCode}</p>
                </div>
                <p className="fine-print">Reserved on {longDate(data.createdAt)}</p>
              </div>
            </article>
            <div className="confirmation-actions">
              <button className="button button-gold" onClick={() => void copyLink()}>Copy private link</button>
              <a className="link" href="/#passes">Reserve more passes</a>
            </div>
            {copied && <p className="notice" role="status" style={{ marginTop: 20 }}>{copied}</p>}
          </>
        )}
      </div>
    </main>
  );
}
