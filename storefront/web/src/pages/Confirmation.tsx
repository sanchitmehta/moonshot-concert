import { useState } from "react";
import { includesLabel, longDate, money, Status } from "../components.tsx";
import { useResource, type Reservation } from "../api.ts";

export function Confirmation({ confirmationCode }: { confirmationCode: string }) {
  const accessKey = new URLSearchParams(window.location.hash.slice(1)).get("key") ?? "";
  const reservation = useResource<Reservation>(`/reservations/${encodeURIComponent(confirmationCode)}`, {
    headers: { "X-Reservation-Access-Key": accessKey },
  });
  const [copied, setCopied] = useState<string>();
  const data = reservation.data;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("Private link copied. Anyone with this link can view your reservation.");
    } catch {
      setCopied("Couldn't copy automatically. Bookmark this page or copy the address bar.");
    }
  }

  if (!accessKey) {
    return (
      <section className="section confirmation">
        <div className="notice error" role="alert">This link is incomplete. Open the full private link you saved when you reserved.</div>
      </section>
    );
  }

  return (
    <section className="section confirmation">
      <Status {...reservation} />
      {data && (
        <>
          <div className="success-symbol">✓</div>
          <p className="eyebrow">YOU'RE GOING</p>
          <h1 className="page-title">See you on<br /><em>the Moon.</em></h1>
          <div className="confirmation-ticket">
            <div className="ticket-header"><span>MOONSHOT FEST · DAY {data.pass.day}</span><span className="badge purple">{data.status}</span></div>
            <h2>{data.pass.name}</h2>
            <div className="ticket-details">
              <div><span>NAME</span><strong>{data.leadName}</strong></div>
              <div><span>PASSES</span><strong>{data.quantity}</strong></div>
              <div><span>INCLUDES</span><strong>{includesLabel(data.pass)}</strong></div>
              <div><span>TOTAL</span><strong>{money(data.total)}</strong></div>
            </div>
            <div className="reference"><span>CONFIRMATION CODE</span><code>{data.confirmationCode}</code></div>
            <p className="small-note">Reserved {longDate(data.createdAt)}</p>
          </div>
          <button className="button primary" onClick={() => void copyLink()}>Copy private link ↗</button>
          <p className="small-note">
            Save this page's full link. It's the only way to view your reservation: the confirmation code alone won't open it.
          </p>
          {copied && <p className="notice" role="status">{copied}</p>}
          <a className="underlined" href="/passes">Explore more passes</a>
        </>
      )}
    </section>
  );
}
