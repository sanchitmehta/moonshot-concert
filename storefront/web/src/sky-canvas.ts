import { BRIGHT_CRATERS, MARIA, SUN, TYCHO, seeded, type Frame, type SkyRenderer } from "./sky-scene.ts";

const TURN = Math.PI * 2;
// On screen y points down, so north on the Moon is negative y.
const sunAngle = Math.atan2(-SUN.y, SUN.x);

function sheet(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, stops: [number, string][]) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  for (const [offset, colour] of stops) gradient.addColorStop(offset, colour);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TURN);
  ctx.fill();
}

// Paints the whole Moon once; each frame then only has to place the finished picture.
function paintMoon(diameter: number) {
  const canvas = sheet(diameter, diameter);
  const ctx = canvas.getContext("2d")!;
  const r = diameter / 2;
  const random = seeded(2027);
  const at = (x: number, y: number) => [r + x * r, r - y * r] as const;

  ctx.beginPath();
  ctx.arc(r, r, r - 0.5, 0, TURN);
  ctx.clip();
  disc(ctx, r, r, r, [[0, "#e9e6df"], [0.8, "#dcd9d2"], [1, "#cfccc6"]]);

  for (const [x, y, rx, ry] of MARIA) {
    for (let i = 0; i < 6; i++) {
      const [cx, cy] = at(x + (random() - 0.5) * rx * 0.9, y + (random() - 0.5) * ry * 0.9);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx * r * (0.6 + random() * 0.5), ry * r * (0.6 + random() * 0.5));
      disc(ctx, 0, 0, 1, [[0, "rgb(92 97 112 / 0.42)"], [0.6, "rgb(92 97 112 / 0.3)"], [1, "rgb(92 97 112 / 0)"]]);
      ctx.restore();
    }
  }

  ctx.lineCap = "round";
  for (let i = 0; i < 420; i++) {
    const angle = random() * TURN, reach = Math.sqrt(random()) * 0.97;
    const size = r * (0.005 + 0.04 * random() ** 4), x = r + Math.cos(angle) * reach * r, y = r + Math.sin(angle) * reach * r;
    disc(ctx, x, y, size, [[0, "rgb(70 72 84 / 0.3)"], [0.8, "rgb(70 72 84 / 0.22)"], [1, "rgb(70 72 84 / 0)"]]);
    ctx.lineWidth = Math.max(0.6, size * 0.3);
    ctx.strokeStyle = "rgb(30 33 48 / 0.42)";
    ctx.beginPath();
    ctx.arc(x, y, size * 0.8, sunAngle - 1.2, sunAngle + 1.2);
    ctx.stroke();
    ctx.strokeStyle = "rgb(255 255 255 / 0.6)";
    ctx.beginPath();
    ctx.arc(x, y, size * 0.9, sunAngle + Math.PI - 1.2, sunAngle + Math.PI + 1.2);
    ctx.stroke();
  }

  const [tx, ty] = at(TYCHO.x, TYCHO.y);
  for (let i = 0; i < 26; i++) {
    const angle = random() * TURN, length = r * (0.35 + random() * 1.1);
    const ex = tx + Math.cos(angle) * length, ey = ty + Math.sin(angle) * length;
    const ray = ctx.createLinearGradient(tx, ty, ex, ey);
    ray.addColorStop(0, "rgb(255 255 255 / 0.4)");
    ray.addColorStop(1, "rgb(255 255 255 / 0)");
    ctx.strokeStyle = ray;
    ctx.lineWidth = r * (0.008 + random() * 0.024);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  for (const [x, y, size, strength] of BRIGHT_CRATERS) {
    const [cx, cy] = at(x, y);
    disc(ctx, cx, cy, size * r * 3, [[0, `rgb(255 255 255 / ${0.75 * strength})`], [0.35, `rgb(255 255 255 / ${0.3 * strength})`], [1, "rgb(255 255 255 / 0)"]]);
  }

  // Night falls across the south-east; a little earthshine keeps the dark limb readable.
  const nx = r + Math.cos(sunAngle) * r * 0.8, ny = r + Math.sin(sunAngle) * r * 0.8;
  const night = ctx.createRadialGradient(nx, ny, r * 0.9, nx, ny, r * 1.72);
  night.addColorStop(0, "rgb(9 14 36 / 0)");
  night.addColorStop(0.55, "rgb(9 14 36 / 0.5)");
  night.addColorStop(1, "rgb(9 14 36 / 0.93)");
  ctx.fillStyle = night;
  ctx.fillRect(0, 0, diameter, diameter);
  disc(ctx, r, r, r, [[0, "rgb(120 160 255 / 0)"], [0.93, "rgb(120 160 255 / 0)"], [1, "rgb(120 160 255 / 0.22)"]]);
  return canvas;
}

type Star = { x: number; y: number; size: number; light: number; depth: number; phase: number };

/** Draws the sky with the 2D canvas API when WebGL is not available. */
export function createCanvasSky(canvas: HTMLCanvasElement): SkyRenderer | undefined {
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  let width = 0, height = 0, scale = 1;
  let moon: HTMLCanvasElement | undefined;
  let stars: Star[] = [];

  return {
    resize(nextWidth, nextHeight, nextScale) {
      width = nextWidth;
      height = nextHeight;
      scale = nextScale;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const random = seeded(384400);
      stars = Array.from({ length: Math.round(width * height / 2600) }, () => {
        const light = random() ** 5;
        return { x: random(), y: random(), size: 0.5 + light * 1.5, light: 0.25 + light * 0.75, depth: 4 + random() * 16, phase: random() * TURN };
      });
      moon = undefined;
    },
    draw({ time, moon: at, earth, drift, rise }: Frame) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, "#02030b");
      sky.addColorStop(1, "#070d24");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "#e9eeff";
      for (const star of stars) {
        ctx.globalAlpha = rise * star.light * (star.light > 0.5 ? 0.75 + 0.25 * Math.sin(time * 1.6 + star.phase) : 1);
        ctx.beginPath();
        ctx.arc(star.x * width - drift.x * star.depth, star.y * height - drift.y * star.depth, star.size, 0, TURN);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      disc(ctx, earth.x, earth.y, earth.r * 1.7, [[0.5, "rgb(70 130 255 / 0.4)"], [1, "rgb(70 130 255 / 0)"]]);
      disc(ctx, earth.x, earth.y, earth.r, [[0, "#050a1e"], [1, "#050a1e"]]);
      ctx.save();
      ctx.beginPath();
      ctx.arc(earth.x, earth.y, earth.r, 0, TURN);
      ctx.clip();
      disc(ctx, earth.x - earth.r * 0.8, earth.y - earth.r * 0.55, earth.r * 1.25, [[0, "#cfe3ff"], [0.5, "#2f6fd6"], [0.8, "#123a86"], [1, "rgb(5 10 30 / 0)"]]);
      ctx.restore();

      disc(ctx, at.x, at.y, at.r * 1.9, [[0.5, `rgb(140 175 255 / ${0.3 * rise})`], [0.62, "rgb(140 175 255 / 0.08)"], [1, "rgb(140 175 255 / 0)"]]);
      if (!moon || Math.abs(moon.width - at.r * 2 * scale) > 2) moon = paintMoon(at.r * 2 * scale);
      ctx.drawImage(moon, at.x - at.r, at.y - at.r, at.r * 2, at.r * 2);

      const fx = at.x + TYCHO.x * at.r, fy = at.y - TYCHO.y * at.r;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = rise;
      const outward = Math.atan2(-TYCHO.y, TYCHO.x);
      for (let i = 0; i < 4; i++) {
        const angle = outward + (i - 1.5) * 0.44 + 0.36 * Math.sin(time * (0.21 + 0.06 * i) + i * 2.4);
        const length = at.r * 0.42;
        const beam = ctx.createLinearGradient(fx, fy, fx + Math.cos(angle) * length, fy + Math.sin(angle) * length);
        beam.addColorStop(0, "rgb(255 214 130 / 0.5)");
        beam.addColorStop(1, "rgb(255 214 130 / 0)");
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + Math.cos(angle - 0.06) * length, fy + Math.sin(angle - 0.06) * length);
        ctx.lineTo(fx + Math.cos(angle + 0.06) * length, fy + Math.sin(angle + 0.06) * length);
        ctx.fill();
      }
      disc(ctx, fx, fy, at.r * 0.09, [[0, "#fff3d6"], [0.12, "rgb(255 200 96 / 0.9)"], [0.4, "rgb(255 190 80 / 0.25)"], [1, "rgb(255 190 80 / 0)"]]);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() {
      moon = undefined;
      stars = [];
    },
  };
}
