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

const mono = "JetBrains Mono, monospace";

export function HeroPoster() {
  return (
    <svg
      viewBox="0 0 1200 860"
      role="img"
      aria-label="Poster art: a giant Moon rising over a lunar ridge while a lone figure walks toward a glowing door standing on the horizon. Tycho Crater is marked on the Moon with the words You are here."
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
        <linearGradient id="msSpill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F1E2C2" stopOpacity="0.32" /><stop offset="100%" stopColor="#F1E2C2" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="1200" height="860" fill="url(#msSky)" />
      <rect width="1200" height="860" fill="url(#msGrid)" />
      <rect width="1200" height="860" fill="url(#msVignette)" />

      <g className="px px-stars">
        <g fill="#EEF0F6">
          {stars.map(([cx, cy, r, twinkle]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} className={twinkle ? "ms-twinkle" : undefined} />)}
        </g>
        <g stroke={ACCENT} strokeWidth="1.5" strokeLinecap="round" className="ms-twinkle">
          <path d="M360 230v14M353 237h14" /><path d="M1060 300v14M1053 307h14" /><path d="M140 460v12M134 466h12" />
        </g>
      </g>

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
          <circle cx="270" cy="270" r="268" fill="url(#msGlow)" />
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
          <path d="M200 366 L150 330 L-40 330" fill="none" stroke={ACCENT} strokeWidth="1.4" />
          <circle cx="-40" cy="330" r="3" fill={ACCENT} />
          <text x="-40" y="318" fontFamily={mono} fontSize="11" fontWeight="500" fill="#F3EEE4" letterSpacing="2.5">YOU ARE HERE</text>
          <text x="-40" y="348" fontFamily={mono} fontSize="9" fill="#AEB7D3" letterSpacing="1">TYCHO · 43.3°S 11.4°W</text>
        </svg>
      </g></g>

      <path d="M0 668 C120 650 260 660 380 654 C520 646 640 650 760 652 C880 654 1000 640 1200 630 L1200 860 L0 860 Z" fill="#070D24" />
      <path d="M0 668 C120 650 260 660 380 654 C520 646 640 650 760 652 C880 654 1000 640 1200 630" fill="none" stroke={ACCENT} strokeOpacity="0.35" strokeWidth="1.5" />
      <g fill="#050A1C" stroke="#1A2754" strokeWidth="1.5">
        <ellipse cx="210" cy="760" rx="96" ry="14" /><ellipse cx="1040" cy="722" rx="62" ry="9" /><ellipse cx="460" cy="706" rx="34" ry="5" />
      </g>

      <ellipse cx="861" cy="616" rx="84" ry="96" fill="url(#msDoorGlow)" className="ms-flicker" />
      <polygon points="846,653 876,653 990,840 730,840" fill="url(#msSpill)" />
      <rect x="844" y="586" width="34" height="67" fill="#03081A" />
      <rect x="848" y="590" width="26" height="63" fill="#F6ECD6" className="ms-flicker" />

      <polygon points="697,652 704,652 636,676 626,674" fill="#000000" opacity="0.45" />
      <g fill="#03081A" stroke="#03081A" strokeLinecap="round">
        <circle cx="701" cy="621" r="4.4" stroke="none" />
        <rect x="697" y="626.5" width="8.5" height="14" rx="2.5" stroke="none" />
        <path d="M699.5 639 L696 652M703 639 L707.5 652" strokeWidth="3" fill="none" />
        <path d="M697.5 629 L694 640M704.5 629 L708 639" strokeWidth="2.4" fill="none" />
      </g>

      <g fill="none" stroke={ACCENT} strokeWidth="2"><path d="M24 70V24h46" /><path d="M1130 24h46v46" /></g>
      <text x="40" y="100" fontFamily={mono} fontSize="12" fill="#AEB7D3" letterSpacing="1.5">DIST 384,400 KM</text>
      <text x="40" y="120" fontFamily={mono} fontSize="12" fill="#AEB7D3" letterSpacing="1.5">GRAV 1.62 M/S²</text>
      <circle cx="1158" cy="96" r="4" fill="#8FE3C0" className="ms-pulse" />
      <text x="1144" y="100" textAnchor="end" fontFamily={mono} fontSize="12" fill="#AEB7D3" letterSpacing="1.5">RESERVATIONS LIVE</text>
    </svg>
  );
}
