import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import {
  Availability, dayName, festivalDates, includesSummary, longDayDate, money, monthDay, Perks, ReserveLink,
  shortDate, sortOffers, Status, TimeUntil, useNow,
} from "../components.tsx";
import { useResource, type Festival, type Offer } from "../api.ts";
import { HeroPoster } from "../poster.tsx";
import { Reveal, useHeroParallax } from "../motion.tsx";
import "./home.css";

const experiences = [
  { value: "", label: "All passes" },
  { value: "general", label: "General admission" },
  { value: "vip", label: "VIP" },
  { value: "drop", label: "Limited drops" },
  { value: "shuttle", label: "Shuttle only" },
] as const;

const tones = ["tone-a", "tone-b", "tone-c"] as const;

function Arrow() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function SectionHead({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <Reveal className="ms-head">
      <div>
        <span className="kicker">{kicker}</span>
        <h2>{title}</h2>
      </div>
      {children && <p>{children}</p>}
    </Reveal>
  );
}

function Corners({ size = 24, inset = 18 }: { size?: number; inset?: number }) {
  const style = { "--corner": `${size}px`, "--inset": `${inset}px` } as CSSProperties;
  return (
    <>
      {["tl", "tr", "bl", "br"].map(position => <span key={position} className={`corner ${position}`} style={style} aria-hidden="true" />)}
    </>
  );
}

function Hero({ festival }: { festival?: Festival }) {
  const parallax = useHeroParallax();
  const headliners = festival?.lineup.filter(act => act.headliner) ?? [];
  const support = festival?.lineup.filter(act => !act.headliner) ?? [];
  return (
    <section id="top" className="ms-hero">
      <div className="poster-wrap" ref={parallax}>
        <HeroPoster />
        <p className="poster-tagline">IN 2027, THE PARTY LEAVES THE PLANET.</p>
      </div>
      <div className="hero-copy">
        <h1>
          <span className="hero-title" aria-label="MOONSHOT">
            {[..."MOONSHOT"].map((letter, index) => (
              <span key={index} aria-hidden="true" style={{ "--i": index } as CSSProperties}>{letter}</span>
            ))}
          </span>
          <span className="hero-fest">FEST</span>
        </h1>
        <p className="hero-when">
          {festival ? `${festivalDates(festival)} · ${festival.venue}`.toUpperCase() : "20–22 AUGUST 2027 · TYCHO CRATER, THE MOON"}
        </p>
        <p className="hero-lede">Three days of music in Tycho Crater, with Earth rising behind the main stage.</p>
        {headliners.length > 0 && (
          <p className="hero-credits">
            Moonshot Fest presents three days, nine artists, one crater · starring{" "}
            {headliners.map(act => <span key={act.artist}><b>{act.artist}</b>{" · "}</span>)}
            with {support.map(act => act.artist).join(" · ")} · on the Main and Crater stages · on location in Tycho Crater, the Moon
          </p>
        )}
        <p className="hero-only">ONLY ON THE MOON</p>
        <div className="hero-actions">
          <a className="button button-gold button-large" href="#passes">Find your pass <Arrow /></a>
          <a className="button button-outline button-large" href="#lineup">See the lineup</a>
        </div>
        {festival && (
          <p className="hero-countdown">
            <span className="pulse-dot" />GATES OPEN IN <TimeUntil until={festival.startsAt} />
          </p>
        )}
      </div>
    </section>
  );
}

function Marquee() {
  const items = ["MOONSHOT FEST", "20–22 AUGUST 2027", "TYCHO CRATER", "NINE ARTISTS, ONE CRATER"];
  const track = [0, 1].flatMap(copy => items.flatMap(text => [<span key={`${copy}-${text}`}>{text}</span>, <span key={`${copy}-${text}-star`}>✦</span>]));
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">{track}</div>
    </div>
  );
}

function Lineup({ festival }: { festival: Festival }) {
  return (
    <section id="lineup" className="ms-section">
      <SectionHead kicker="[ 01 ] LINEUP" title="Three days, nine artists, one crater">
        Each night ends on the Main stage as Earth climbs above the crater rim. The Crater stage runs from the moment gates open.
      </SectionHead>
      <Reveal className="lineup-card">
        <Corners />
        <ol className="lineup">
          {festival.days.map((day, index) => {
            const acts = festival.lineup.filter(act => act.day === day.day);
            const headliner = acts.find(act => act.headliner);
            const support = acts.filter(act => !act.headliner);
            return (
              <Reveal as="li" delay={index * 140} key={day.day}>
                <time dateTime={day.date} className={`ms-chamfer day-badge ${tones[index % tones.length]}`}>
                  {`DAY ${day.day} · ${dayName(day.gatesOpenAt)} ${monthDay(day.gatesOpenAt)}`.toUpperCase()}
                </time>
                {headliner && (
                  <>
                    <span className="stage-label">CLOSING THE {headliner.stage.toUpperCase()} STAGE</span>
                    <h3>{headliner.artist}</h3>
                  </>
                )}
                {support.length > 0 && (
                  <>
                    <span className="stage-label">ON THE {support[0]!.stage.toUpperCase()} STAGE</span>
                    <ul>
                      {support.flatMap((act, i) => [
                        i > 0 ? <li key={`star-${act.artist}`} aria-hidden="true" className="star">✦</li> : null,
                        <li key={act.artist}>{act.artist}</li>,
                      ])}
                    </ul>
                  </>
                )}
              </Reveal>
            );
          })}
        </ol>
      </Reveal>
    </section>
  );
}

function spotlight(event: PointerEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--mx", `${event.clientX - box.left}px`);
  event.currentTarget.style.setProperty("--my", `${event.clientY - box.top}px`);
}

function Drops({ offers }: { offers: Offer[] }) {
  if (!offers.length) return null;
  return (
    <section id="drops" className="ms-section">
      <SectionHead kicker="[ 02 ] LIMITED DROPS" title="Limited drops">
        Experiences with only a few dozen places each. Counts update while you watch.
      </SectionHead>
      <div className="drops">
        {offers.map((offer, index) => (
          <Reveal as="article" className={`drop ${tones[index % 2]}`} delay={index * 140} key={offer.offerId} onPointerMove={spotlight}>
            <div className="drop-top">
              <div>
                <span className="drop-day">DAY {offer.day}, {dayName(offer.salesCloseAt).toUpperCase()}</span>
                <h3>{offer.name}</h3>
              </div>
              <p className="drop-price">{money(offer.unitPrice)}<small>per pass</small></p>
            </div>
            <p className="drop-desc">{offer.description}</p>
            <Perks perks={offer.perks} className="includes stacked" />
            <div className="drop-foot">
              <Availability offer={offer} tone="dark" />
              <ReserveLink offer={offer} />
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function PassRow({ offer }: { offer: Offer }) {
  return (
    <li className="pass-row">
      <div className="pass-info">
        <div className="pass-title">
          <h4>{offer.name.replace(/^Day \d+ /, "")}</h4>
          <span>{includesSummary(offer)}{offer.limitedAvailability && offer.saleType === "STANDARD" ? ", limited availability" : ""}</span>
        </div>
        <Perks perks={offer.perks} />
      </div>
      <div className="pass-buy">
        <Availability offer={offer} tone="dark" />
        <p className="price">{money(offer.unitPrice)} <small>each</small></p>
        <ReserveLink offer={offer} />
      </div>
    </li>
  );
}

function Passes({ festival }: { festival?: Festival }) {
  const initial = new URLSearchParams(window.location.search);
  const [day, setDay] = useState(initial.get("day") ?? "");
  const [experience, setExperience] = useState(initial.get("experience") ?? "");
  const query = new URLSearchParams();
  if (day) query.set("day", day);
  if (experience) query.set("experience", experience);
  const offers = useResource<Offer[]>(`/offers?${query}`, { refreshMs: 15_000 });

  return (
    <section id="passes" className="passes-band">
      <div className="ms-section">
        <SectionHead kicker="[ 03 ] PASSES" title="Choose your pass">
          Every pass covers one festival day. Add the shuttle to ride between the lunar arrival hub and the crater.
        </SectionHead>
        <div className="filters">
          <div className="tabs" role="group" aria-label="Festival day">
            <button aria-pressed={day === ""} onClick={() => setDay("")}>All days</button>
            {festival?.days.map(d => (
              <button key={d.day} aria-pressed={day === String(d.day)} onClick={() => setDay(String(d.day))}>
                {shortDate(d.gatesOpenAt)}
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Type of pass">
            {experiences.map(option => (
              <button key={option.value} aria-pressed={experience === option.value} onClick={() => setExperience(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <Status {...offers} loading={offers.loading && !offers.data} />
        {offers.data && (offers.data.length
          ? (
            <div className="pass-days" aria-live="polite">
              {[1, 2, 3].map(dayNumber => {
                const dayOffers = sortOffers(offers.data!.filter(offer => offer.day === dayNumber));
                if (!dayOffers.length) return null;
                const info = festival?.days.find(d => d.day === dayNumber);
                return (
                  <section key={dayNumber} className="pass-day" aria-label={`Day ${dayNumber} passes`}>
                    <h3>
                      Day {dayNumber}{info ? <span>{`${dayName(info.gatesOpenAt)}, ${longDayDate(info.gatesOpenAt)}`.toUpperCase()}</span> : null}
                    </h3>
                    <ul className="pass-list">{dayOffers.map(offer => <PassRow key={offer.offerId} offer={offer} />)}</ul>
                  </section>
                );
              })}
            </div>
          )
          : <p className="empty">No passes match. Try another day or type of pass.</p>)}
      </div>
    </section>
  );
}

const steps = [
  { title: "Arrive at the lunar arrival hub", text: "Every landing comes in at the hub on the edge of Tycho Crater. From there it is a short ride to the festival site." },
  { title: "Take the shuttle", text: "Shuttles run between the hub and the crater from three hours before gates open until the last set ends. Add one to your pass or reserve it on its own." },
  { title: "One pass, one day", text: "Each pass is for a single festival day. Reserve up to six passes at a time under one name." },
];

const facts = [
  { value: "~85 km", label: "TYCHO CRATER DIAMETER" },
  { value: "~4.8 km", label: "RIM TO FLOOR" },
  { value: "384,400 km", label: "FROM EARTH" },
  { value: "1/6 g", label: "ON THE DANCE FLOOR" },
];

function GettingThere() {
  return (
    <section id="getting-there" className="ms-section">
      <SectionHead kicker="[ 04 ] GETTING THERE" title="Getting there" />
      <div className="steps">
        {steps.map((step, index) => (
          <Reveal className="step" delay={index * 120} key={step.title}>
            <span className={`step-no ${tones[index]}`}>{String(index + 1).padStart(2, "0")}</span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </Reveal>
        ))}
      </div>
      <div className="facts">
        {facts.map((fact, index) => (
          <Reveal key={fact.label} delay={index * 90}>
            <span className={`fact-value fact-${index}`}>{fact.value}</span>
            <span className="fact-label">{fact.label}</span>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function FinalCall({ festival }: { festival?: Festival }) {
  const now = useNow(60_000);
  const days = festival ? Math.max(0, Math.floor((Date.parse(festival.startsAt) - now) / 86_400_000)) : undefined;
  return (
    <section className="ms-section final">
      <Reveal className="final-card">
        <Corners size={28} inset={20} />
        <svg className="final-moon" viewBox="0 0 400 400" aria-hidden="true">
          <circle cx="200" cy="200" r="190" fill="#1A2B5E" /><circle cx="140" cy="150" r="30" fill="#22346C" />
          <circle cx="250" cy="120" r="18" fill="#22346C" /><circle cx="230" cy="250" r="40" fill="#22346C" />
        </svg>
        <svg className="final-star ms-spin" viewBox="0 0 60 60" aria-hidden="true">
          <path d="M30 2 L35 25 L58 30 L35 35 L30 58 L25 35 L2 30 L25 25 Z" fill="#B8C4DE" />
        </svg>
        <span className="final-kicker">
          {days !== undefined && `T–${days} DAYS · `}{festival ? festivalDates(festival).toUpperCase() : "20–22 AUGUST 2027"}
        </span>
        <h2>See you on<br /><em>the Moon.</em></h2>
        <a className="button button-gold button-large" href="#passes">Find your pass <Arrow /></a>
      </Reveal>
    </section>
  );
}

export function Home() {
  const festival = useResource<Festival>("/festival");
  const drops = useResource<Offer[]>("/offers?experience=drop", { refreshMs: 15_000 });
  const scrolledToHash = useRef(false);

  // Content above the anchors loads asynchronously, so re-apply the URL's #section once it has.
  useEffect(() => {
    if (scrolledToHash.current || !festival.data || !drops.data || !window.location.hash) return;
    scrolledToHash.current = true;
    requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView());
  }, [festival.data, drops.data]);

  return (
    <div className="ms">
      <Hero festival={festival.data} />
      <Marquee />
      {festival.error && <div className="ms-section"><Status {...festival} /></div>}
      {festival.data && <Lineup festival={festival.data} />}
      <Drops offers={drops.data ?? []} />
      <Passes festival={festival.data} />
      <GettingThere />
      <FinalCall festival={festival.data} />
    </div>
  );
}
