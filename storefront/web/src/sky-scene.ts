// Shared description of the hero sky, drawn by the WebGL renderer or the canvas fallback.

/** One frame of the sky. Positions are CSS pixels inside the hero, y pointing down. */
export type Frame = {
  time: number;
  moon: Disc;
  earth: Disc;
  /** Smoothed pointer offset, -1 to 1 on each axis. */
  drift: { x: number; y: number };
  /** 0 while the Moon is still below the title, 1 once the entrance has finished. */
  rise: number;
};

export type Disc = { x: number; y: number; r: number };

export interface SkyRenderer {
  resize(width: number, height: number, scale: number): void;
  draw(frame: Frame): void;
  dispose(): void;
}

// Near-side positions as seen from Earth: x east, y north, in Moon radii.
export const TYCHO = { x: -0.144, y: -0.686 };

// The lunar seas: [x, y, radius x, radius y].
export const MARIA: [number, number, number, number][] = [
  [-0.25, 0.55, 0.3, 0.27], // Imbrium
  [0.28, 0.46, 0.18, 0.17], // Serenitatis
  [0.48, 0.15, 0.22, 0.17], // Tranquillitatis
  [0.79, 0.28, 0.08, 0.11], // Crisium
  [0.7, -0.08, 0.11, 0.15], // Fecunditatis
  [0.52, -0.27, 0.09, 0.09], // Nectaris
  [-0.62, 0.3, 0.26, 0.36], // Procellarum
  [-0.5, 0.0, 0.2, 0.16], // Insularum
  [-0.56, -0.4, 0.1, 0.1], // Humorum
  [-0.2, -0.35, 0.2, 0.15], // Nubium
  [0.05, 0.83, 0.36, 0.035], // Frigoris
  [0.06, 0.23, 0.07, 0.06], // Vaporum
];

// Young, bright craters: [x, y, radius, ray strength].
export const BRIGHT_CRATERS: [number, number, number, number][] = [
  [TYCHO.x, TYCHO.y, 0.034, 1],
  [-0.337, 0.167, 0.03, 0.5], // Copernicus
  [-0.61, 0.14, 0.014, 0.4], // Kepler
  [-0.674, 0.4, 0.016, 0.45], // Aristarchus
  [0.66, -0.3, 0.02, 0.3], // Langrenus
  [0.3, 0.72, 0.02, 0.22], // Aristoteles
];

// Direction to the Sun: lights the north-west and leaves the southern limb in earthshine.
export const SUN = { x: -0.617, y: 0.532, z: 0.585 };

/** Small deterministic generator so the fallback sky looks the same on every visit. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
