import { useState } from "react";
import { OfferCard, Status } from "../components.tsx";
import { useResource, type Offer } from "../api.ts";

export function Passes() {
  const initial = new URLSearchParams(window.location.search);
  const [day, setDay] = useState(initial.get("day") ?? "");
  const [experience, setExperience] = useState(initial.get("experience") ?? "");
  const [shuttle, setShuttle] = useState(initial.get("shuttle") ?? "");

  const query = new URLSearchParams();
  if (day) query.set("day", day);
  if (experience) query.set("experience", experience);
  if (shuttle) query.set("shuttle", shuttle);
  const offers = useResource<Offer[]>(`/offers?${query}`, { refreshMs: 15_000 });

  return (
    <section className="section page-section">
      <p className="eyebrow">PASSES</p>
      <h1 className="page-title">Choose your <em>orbit.</em></h1>
      <p className="page-description">One day, VIP, or a once-in-a-lifetime drop. Every pass is for a single festival day.</p>

      <div className="filter-bar">
        <label>DAY
          <select value={day} onChange={event => setDay(event.target.value)}>
            <option value="">All days</option>
            {[1, 2, 3].map(value => <option key={value} value={value}>Day {value}</option>)}
          </select>
        </label>
        <label>EXPERIENCE
          <select value={experience} onChange={event => setExperience(event.target.value)}>
            <option value="">Everything</option>
            <option value="general">General admission</option>
            <option value="vip">VIP</option>
            <option value="drop">Exclusive drops</option>
            <option value="shuttle">Shuttle only</option>
          </select>
        </label>
        <label>SHUTTLE
          <select value={shuttle} onChange={event => setShuttle(event.target.value)}>
            <option value="">Any</option>
            <option value="included">Shuttle included</option>
            <option value="excluded">No shuttle</option>
          </select>
        </label>
        <span className="results-note">{offers.data ? `${offers.data.length} PASSES` : ""}</span>
      </div>

      <Status {...offers} />
      {offers.data && (offers.data.length
        ? <div className="offer-grid">{offers.data.map(offer => <OfferCard key={offer.offerId} offer={offer} />)}</div>
        : <div className="notice">No passes match those filters.</div>)}

      <p className="small-note bottom-note">
        Prices in USD per pass. The shuttle runs between the lunar arrival hub and Tycho Crater. Availability refreshes every 15 seconds and is confirmed when you reserve.
      </p>
    </section>
  );
}
