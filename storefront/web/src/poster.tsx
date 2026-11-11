import type { CSSProperties } from "react";

const ACCENT = "#F4C452";
const ACCENT2 = "#B8C4DE";

// [cx, cy, r, twinkles]
const stars: [number, number, number, boolean?][] = [
  [60, 140, 1.4], [150, 60, 1], [230, 210, 1.8, true], [330, 110, 1.1], [120, 330, 1.3],
  [260, 400, 1.6, true], [80, 520, 1], [190, 590, 1.2], [420, 60, 1.9, true], [560, 40, 1],
  [760, 56, 1.5], [880, 120, 1.2, true], [990, 70, 1], [1090, 160, 1.2], [1150, 300, 1.7, true],
  [1040, 380, 1], [1120, 470, 1.3], [980, 540, 1.1], [1170, 580, 1], [940, 250, 1.6, true],
  [30, 250, 1], [300, 300, 1], [1010, 210, 1], [680, 22, 1.2],
];

// Out-of-focus dust motes in front of everything; they travel furthest, which sells the depth.
const dust: [number, number, number][] = [
  [90, 520, 5], [210, 300, 3], [330, 610, 4], [470, 450, 6], [600, 560, 3], [720, 380, 4], [820, 600, 5],
  [980, 440, 3], [1080, 560, 6], [1140, 250, 4], [160, 130, 3], [540, 200, 4], [900, 160, 3], [1010, 620, 4],
];

const mono = "JetBrains Mono, monospace";

// Spotlight beams fanning out from the concert stage; each one sways on its own cycle.
const beams = [
  { points: "896,628 914,628 770,30 640,30", color: "#F4C452", duration: 5.5, delay: 0, sway: 9 },
  { points: "896,628 914,628 990,-30 820,-30", color: "#7FD6FF", duration: 7, delay: -2, sway: 6 },
  { points: "896,628 914,628 1190,30 1060,30", color: "#FF6FB5", duration: 6.2, delay: -3.5, sway: 10 },
  { points: "896,628 914,628 560,120 440,120", color: "#8FE3C0", duration: 8, delay: -1, sway: 12 },
  { points: "896,628 914,628 1230,200 1130,200", color: "#B58CFF", duration: 7.4, delay: -4.5, sway: 11 },
];

const beamColors = [...new Set(beams.map(beam => beam.color))];

// Shooting stars: [start x, start y, delay s, duration s]
const comets: [number, number, number, number][] = [[1000, 80, 1.5, 7], [520, 150, 5, 9], [880, 260, 9, 8]];

// Sparks drifting up from the stage: [x offset, delay s, duration s, colour]
const sparks: [number, number, number, string][] = [
  [-70, 0, 3.2, "#F4C452"], [-45, 1.1, 2.8, "#7FD6FF"], [-20, 0.4, 3.6, "#FF6FB5"], [5, 1.7, 3, "#F4C452"],
  [30, 0.8, 3.4, "#8FE3C0"], [55, 2.2, 2.9, "#B58CFF"], [80, 1.4, 3.3, "#F4C452"], [-95, 2.5, 3.1, "#FF6FB5"], [100, 0.2, 3.5, "#7FD6FF"],
];

// Fixed crowd in front of the stage, in two rows; [x offset from stage centre, row].
const crowd = [-96, -80, -63, -47, -30, -14, 3, 19, 36, 52, 69, 86, 103].flatMap((offset, i) => [
  { x: 905 + offset, y: 672, scale: 1, arms: i % 3 === 0, delay: (i * 0.37) % 1.4 },
  { x: 905 + offset + 8, y: 690, scale: 1.25, arms: i % 4 === 1, delay: (i * 0.53) % 1.4 },
]);

export function HeroPoster() {
  return (
    <svg
      viewBox="0 0 1200 860"
      role="img"
      aria-label="Poster art: a giant Moon rising over a lunar ridge while a lone figure walks toward a concert on the horizon, where a crowd dances under sweeping spotlight beams. Tycho Crater is marked on the Moon with the words You are here."
      className="poster"
    >
      <defs>
        <linearGradient id="msSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0A1230" /><stop offset="75%" stopColor="#0B1538" /><stop offset="100%" stopColor="#070D24" />
        </linearGradient>
        <pattern id="msGrid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#1A2A58" strokeWidth="1" /></pattern>
        <radialGradient id="msVignette" cx="50%" cy="48%" r="62%">
          <stop offset="0%" stopColor="#0A1230" stopOpacity="0" /><stop offset="100%" stopColor="#070D24" stopOpacity="1" />
        </radialGradient>
        <radialGradient id="msDoorGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#F1E2C2" stopOpacity="0.55" /><stop offset="100%" stopColor="#F1E2C2" stopOpacity="0" />
        </radialGradient>
        {beamColors.map(color => (
          <linearGradient key={color} id={`msBeam${color.slice(1)}`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity="0.5" /><stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        ))}
        <linearGradient id="msComet" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" /><stop offset="100%" stopColor="#FFFFFF" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="msSpill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F1E2C2" stopOpacity="0.32" /><stop offset="100%" stopColor="#F1E2C2" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1200" height="860" fill="url(#msSky)" />
      <rect width="1200" height="860" fill="url(#msGrid)" />
      <rect width="1200" height="860" fill="url(#msVignette)" />

      <g className="px px-stars-far">
        <g fill="#EEF0F6" opacity="0.7">
          {stars.filter((_, i) => i % 2 === 0).map(([cx, cy, r, twinkle]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r * 0.8} className={twinkle ? "ms-twinkle" : undefined} />)}
        </g>
      </g>

      <g className="px px-stars">
        <g fill="#EEF0F6">
          {stars.filter((_, i) => i % 2 === 1).map(([cx, cy, r, twinkle]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r * 1.3} className={twinkle ? "ms-twinkle" : undefined} />)}
        </g>
        <g stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" className="ms-twinkle">
          <path d="M360 230v14M353 237h14" /><path d="M1060 300v14M1053 307h14" /><path d="M96 404v12M90 410h12" />
        </g>
      </g>

      {comets.map(([x, y, delay, duration]) => (
        <g key={x} className="ms-comet" style={{ animationDelay: `${delay}s`, animationDuration: `${duration}s` }}>
          <rect x={x} y={y} width="140" height="2" rx="1" fill="url(#msComet)" transform={`rotate(24 ${x} ${y})`} />
        </g>
      ))}

      <g className="px px-moon"><g className="ms-float">
        <svg x="227" y="47" width="745" height="745" viewBox="0 0 540 540" overflow="visible">
          <defs>
            <radialGradient id="msGlow" cx="50%" cy="50%" r="50%">
              <stop offset="55%" stopColor="#C9D3F0" stopOpacity="0.26" /><stop offset="100%" stopColor="#C9D3F0" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="msMoon" cx="36%" cy="32%" r="75%">
              <stop offset="0%" stopColor="#FBF9F3" /><stop offset="50%" stopColor="#D6D3CB" /><stop offset="85%" stopColor="#A29F98" /><stop offset="100%" stopColor="#7C7A76" />
            </radialGradient>
            <linearGradient id="msShade" x1="0" y1="0" x2="1" y2="0.3">
              <stop offset="50%" stopColor="#0A1230" stopOpacity="0" /><stop offset="100%" stopColor="#0A1230" stopOpacity="0.6" />
            </linearGradient>
            <clipPath id="msDisc"><circle cx="270" cy="270" r="196" /></clipPath>
          </defs>
          <circle cx="270" cy="270" r="268" fill="url(#msGlow)" className="ms-breathe" />
          <circle cx="270" cy="270" r="222" fill="none" stroke="#3A4B82" strokeWidth="6" strokeDasharray="1 10" />
          <g className="ms-orbit" style={{ transformOrigin: "270px 270px" }}>
            <circle cx="270" cy="270" r="250" fill="none" stroke="#2A3A6E" strokeWidth="1" strokeDasharray="2 6" />
            <circle cx="270" cy="20" r="4.5" fill={ACCENT2} />
            <circle cx="270" cy="20" r="10" fill="none" stroke={ACCENT2} strokeOpacity="0.5" />
          </g>
          <circle cx="270" cy="270" r="196" fill="url(#msMoon)" />
          <g clipPath="url(#msDisc)">
            <g fill="#8F8C86" opacity="0.5">
              <ellipse cx="205" cy="180" rx="64" ry="44" /><ellipse cx="315" cy="168" rx="48" ry="36" /><ellipse cx="335" cy="246" rx="40" ry="30" />
              <ellipse cx="180" cy="262" rx="32" ry="24" /><ellipse cx="128" cy="200" rx="22" ry="34" />
            </g>
            <g fill="#C3C0B8" stroke="#ECE9E2" strokeWidth="1.5">
              <circle cx="350" cy="335" r="15" /><circle cx="150" cy="320" r="11" /><circle cx="378" cy="208" r="9" /><circle cx="238" cy="120" r="8" />
              <circle cx="300" cy="420" r="10" /><circle cx="125" cy="240" r="6" /><circle cx="410" cy="290" r="7" />
            </g>
            <g stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="2.2" strokeLinecap="round">
              <path d="M222 388 L222 220" /><path d="M222 388 L360 270" /><path d="M222 388 L100 280" /><path d="M222 388 L400 380" /><path d="M222 388 L70 400" />
              <path d="M222 388 L320 480" /><path d="M222 388 L140 480" /><path d="M222 388 L290 230" /><path d="M222 388 L160 225" />
            </g>
            <rect x="0" y="0" width="540" height="540" fill="url(#msShade)" />
            <rect x="74" y="0" width="392" height="1.5" fill={ACCENT2} opacity="0.7" className="ms-scan" />
          </g>
          <circle cx="222" cy="388" r="15" fill="#E6E3DC" stroke="#FFFFFF" strokeWidth="2.5" />
          <circle cx="222" cy="388" r="3" fill="#8F8C86" />
          <circle cx="222" cy="388" r="30" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeDasharray="5 6" className="ms-spin" style={{ transformOrigin: "222px 388px" }} />
          <path d="M222 350V340M222 426V436M184 388H174M260 388H270" stroke={ACCENT} strokeWidth="2" />
          <g className="poster-wide">
            <path d="M200 366 L150 330 L-56 330" fill="none" stroke={ACCENT} strokeWidth="1.4" />
            <circle cx="-56" cy="330" r="3" fill={ACCENT} />
            <text x="-56" y="318" fontFamily={mono} fontSize="11" fontWeight="500" fill="#F3EEE4" letterSpacing="2.5">YOU ARE HERE</text>
            <text x="-56" y="348" fontFamily={mono} fontSize="9" fill="#AEB7D3" letterSpacing="1">TYCHO · 43.3°S 11.4°W</text>
          </g>
          {/* A phone shows the poster at a third of this size, so the callout is drawn larger there and drops the coordinates. */}
          <g className="poster-compact">
            <path d="M200 366 L150 330 L-106 330" fill="none" stroke={ACCENT} strokeWidth="2.6" />
            <circle cx="-106" cy="330" r="5.5" fill={ACCENT} />
            <text x="-106" y="316" fontFamily={mono} fontSize="20" fontWeight="500" fill="#F3EEE4" letterSpacing="2.6">YOU ARE HERE</text>
          </g>
        </svg>
      </g></g>

      <g className="px px-ridge">
        <path d="M-120 640 C80 596 220 626 340 604 C460 584 560 624 700 606 C820 592 940 628 1100 600 L1320 612 L1320 720 L-120 720 Z" fill="#0D1A44" stroke="#2A3A6E" strokeOpacity="0.6" strokeWidth="1.2" />
      </g>

      <g className="px px-ground">
        <g className="ms-strobe" style={{ mixBlendMode: "screen" }}>
          {beams.map(beam => (
            <g key={beam.points} className="ms-sway" style={{ transformOrigin: "905px 640px", animationDuration: `${beam.duration}s`, animationDelay: `${beam.delay}s`, "--sway": `${beam.sway}deg` } as CSSProperties}>
              <polygon points={beam.points} fill={`url(#msBeam${beam.color.slice(1)})`} />
            </g>
          ))}
        </g>

        <path d="M-90 672 L0 668 C120 650 260 660 380 654 C520 646 640 650 760 652 C880 654 1000 640 1200 630 L1290 626 L1290 860 L-90 860 Z" fill="#070D24" />
        <path d="M-90 672 L0 668 C120 650 260 660 380 654 C520 646 640 650 760 652 C880 654 1000 640 1200 630 L1290 626" fill="none" stroke={ACCENT} strokeOpacity="0.35" strokeWidth="1.5" />
        <g fill="#050A1C" stroke="#1A2754" strokeWidth="1.5">
          <ellipse cx="210" cy="760" rx="96" ry="14" /><ellipse cx="1040" cy="722" rx="62" ry="9" /><ellipse cx="460" cy="706" rx="34" ry="5" />
        </g>

        <ellipse cx="905" cy="625" rx="170" ry="100" fill="url(#msDoorGlow)" className="ms-beat" />
        <g style={{ mixBlendMode: "screen" }}>
          {sparks.map(([offset, delay, duration, color]) => (
            <circle key={offset} cx={905 + offset} cy="640" r="2.4" fill={color} className="ms-spark" style={{ animationDelay: `${delay}s`, animationDuration: `${duration}s` }} />
          ))}
        </g>
        <polygon points="860,653 950,653 1070,850 740,850" fill="url(#msSpill)" />

        <rect x="793" y="648" width="224" height="10" rx="2" fill="#1D2647" stroke="#3A4B82" strokeWidth="1" />
        <path d="M815 650 C830 556 980 556 995 650 Z" fill="#1D2647" stroke="#3A4B82" strokeWidth="1.5" />
        <path d="M840 650 C852 598 958 598 970 650 Z" fill="#F6ECD6" className="ms-flicker" />
        <g fill="#03081A" stroke="#03081A" strokeLinecap="round">
          <circle cx="905" cy="624" r="4" stroke="none" /><rect x="901" y="629" width="8" height="14" rx="2.5" stroke="none" />
          <path d="M902 642 L899 650M908 642 L911 650" strokeWidth="2.6" fill="none" />
          <path d="M901 631 L893 619M909 631 L917 619" strokeWidth="2.2" fill="none" />
          <circle cx="868" cy="634" r="3" stroke="none" /><rect x="865" y="638" width="6" height="12" rx="2" stroke="none" />
          <circle cx="944" cy="634" r="3" stroke="none" /><rect x="941" y="638" width="6" height="12" rx="2" stroke="none" />
        </g>
        <g fill={ACCENT}>
          {[[860, 614], [883, 600], [905, 596], [927, 600], [950, 614]].map(([cx, cy], i) => (
            <circle key={cx} cx={cx} cy={cy} r="2.6" className="ms-twinkle" style={{ animationDelay: `${i * 0.35}s` }} />
          ))}
        </g>

        <g fill="#03081A" stroke="#03081A" strokeLinecap="round">
          {crowd.map((person, index) => (
            <g key={index} className="ms-bob" style={{ animationDelay: `${person.delay}s`, transformBox: "fill-box", transformOrigin: "bottom" } as CSSProperties}>
              <circle cx={person.x} cy={person.y - 15 * person.scale} r={3.5 * person.scale} stroke="none" />
              <rect x={person.x - 3.4 * person.scale} y={person.y - 11.5 * person.scale} width={6.8 * person.scale} height={11.5 * person.scale} rx={2.4 * person.scale} stroke="none" />
              {person.arms && <path d={`M${person.x - 3 * person.scale} ${person.y - 10 * person.scale} L${person.x - 7 * person.scale} ${person.y - 21 * person.scale}M${person.x + 3 * person.scale} ${person.y - 10 * person.scale} L${person.x + 7 * person.scale} ${person.y - 21 * person.scale}`} strokeWidth={2 * person.scale} fill="none" />}
            </g>
          ))}
        </g>

        <polygon points="697,652 704,652 636,676 626,674" fill="#000000" opacity="0.45" />
        <g fill="#03081A" stroke="#03081A" strokeLinecap="round">
          <circle cx="701" cy="621" r="4.4" stroke="none" />
          <rect x="697" y="626.5" width="8.5" height="14" rx="2.5" stroke="none" />
          <path d="M699.5 639 L696 652M703 639 L707.5 652" strokeWidth="3" fill="none" />
          <path d="M697.5 629 L694 640M704.5 629 L708 639" strokeWidth="2.4" fill="none" />
        </g>
      </g>

      <g className="px px-dust" fill="#F3EEE4" opacity="0.5">
        {dust.map(([cx, cy, r]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} style={{ filter: "blur(1.5px)" }} />)}
      </g>

      <g fill="none" stroke={ACCENT} strokeWidth="2"><path d="M24 70V24h46" /><path d="M1130 24h46v46" /></g>
      <g className="poster-wide">
        <text x="40" y="100" fontFamily={mono} fontSize="12" fill="#AEB7D3" letterSpacing="1.5">DIST 384,400 KM</text>
        <text x="40" y="120" fontFamily={mono} fontSize="12" fill="#AEB7D3" letterSpacing="1.5">GRAV 1.62 M/S²</text>
        <circle cx="1158" cy="96" r="4" fill="#8FE3C0" className="ms-pulse" />
        <text x="1144" y="100" textAnchor="end" fontFamily={mono} fontSize="12" fill="#AEB7D3" letterSpacing="1.5">RESERVATIONS LIVE</text>
      </g>
    </svg>
  );
}
