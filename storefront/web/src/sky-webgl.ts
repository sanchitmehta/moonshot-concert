import { BRIGHT_CRATERS, MARIA, SUN, TYCHO, type Frame, type SkyRenderer } from "./sky-scene.ts";

const f = (value: number) => value.toFixed(4);
const onSphere = (x: number, y: number) => `vec3(${f(x)}, ${f(y)}, ${f(Math.sqrt(1 - x * x - y * y))})`;

const VERTEX = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const NOISE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
float hash1(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash2(vec2 p) { float n = hash1(p); return vec2(n, hash1(p + n + 17.1)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), w = fract(p);
  w = w * w * (3.0 - 2.0 * w);
  return mix(mix(hash1(i), hash1(i + vec2(1.0, 0.0)), w.x), mix(hash1(i + vec2(0.0, 1.0)), hash1(i + vec2(1.0, 1.0)), w.x), w.y);
}
float fbm(vec2 p) {
  float amplitude = 0.5, sum = 0.0;
  for (int i = 0; i < 5; i++) { sum += amplitude * vnoise(p); p = p * 2.03 + vec2(17.3, 9.1); amplitude *= 0.5; }
  return sum;
}
`;

// The surface is drawn once into a texture: albedo in red, the slope of the terrain in green and blue.
// It is laid out as a stereographic map of the near side, which keeps craters round all the way to the limb.
const SURFACE = `${NOISE}
uniform vec2 uSize;
const float EXTENT = 1.2;

vec3 sphere(vec2 q) { float s = dot(q, q); return vec3(2.0 * q, 1.0 - s) / (1.0 + s); }

float sea(vec2 w, vec2 centre, vec2 radius) { return 1.0 - length((w - centre) / radius); }

float maria(vec3 p) {
  vec2 w = p.xy + 0.17 * (vec2(fbm(p.xy * 2.6 + 4.0), fbm(p.xy * 2.6 + 19.0)) - 0.5) + 0.04 * (vec2(fbm(p.xy * 11.0 + 7.0), fbm(p.xy * 11.0 + 23.0)) - 0.5);
  float m = -1.0;
${MARIA.map(([x, y, rx, ry]) => `  m = max(m, sea(w, vec2(${f(x)}, ${f(y)}), vec2(${f(rx)}, ${f(ry)})));`).join("\n")}
  return smoothstep(-0.05, 0.13, m + (fbm(p.xy * 7.0) - 0.5) * 0.4 + (fbm(p.xy * 31.0) - 0.5) * 0.12) * smoothstep(-0.05, 0.1, p.z);
}

// Height across a crater, by distance from its centre in crater radii: a flat floor, a raised rim and a short apron.
float bowl(float t) {
  float rim = (t - 1.0) / 0.24;
  return -0.55 * (1.0 - smoothstep(0.5, 1.0, t)) + 0.3 * exp(-rim * rim);
}

float craters(vec2 q, float scale, float seed, float density) {
  vec2 g = q * scale, cell = floor(g);
  float h = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      if (hash1(c * 1.7 + seed + 3.1) > density) continue;
      vec2 rnd = hash2(c + seed);
      float radius = mix(0.1, 0.4, rnd.x * rnd.x);
      vec2 centre = c + 0.5 + (hash2(c + seed + 7.7) - 0.5) * 0.5;
      h += radius * bowl(length(g - centre) / radius) * (0.6 + 0.8 * rnd.y);
    }
  }
  return h / scale;
}

float named(vec3 p, vec3 centre, float radius, float peak) {
  float t = length(p - centre) / radius;
  return radius * (1.3 * bowl(t) + peak * exp(-t * t * 26.0));
}

float relief(vec2 q, float mare) {
  vec3 p = sphere(q);
  float h = craters(q, 4.0, 11.0, 0.22) * 0.45 * mix(1.0, 0.1, mare);
  h += craters(q, 8.0, 23.0, 0.4) * 0.6 * mix(1.0, 0.15, mare);
  h += craters(q, 16.0, 37.0, 0.55) * 0.8 * mix(1.0, 0.25, mare);
  h += craters(q, 33.0, 51.0, 0.7) * mix(1.0, 0.4, mare);
  h += craters(q, 67.0, 73.0, 0.8) * mix(1.0, 0.55, mare);
  h += craters(q, 135.0, 91.0, 0.8) * 0.9;
  h += (fbm(q * 12.0) - 0.5) * 0.034 * mix(1.0, 0.3, mare) + (fbm(q * 47.0) - 0.5) * 0.007;
${BRIGHT_CRATERS.map(([x, y, r], index) => `  h += named(p, ${onSphere(x, y)}, ${f(r)}, ${index === 0 ? "0.3" : "0.15"});`).join("\n")}
  return h;
}

// Bright streaks of ejecta thrown out from a young crater.
float rays(vec3 p, vec3 centre, float count, float reach) {
  float along = clamp(dot(p, centre), -1.0, 1.0);
  float range = acos(along);
  vec3 v = p - centre * along;
  vec3 e1 = normalize(cross(centre, vec3(0.0, 1.0, 0.0)));
  vec3 e2 = cross(centre, e1);
  vec2 dir = normalize(vec2(dot(v, e1), dot(v, e2)) + 1e-5);
  float broad = smoothstep(0.48, 0.85, vnoise(dir * count + centre.xy * 40.0));
  float fine = smoothstep(0.55, 0.9, vnoise(dir * count * 3.3 + 9.0));
  float broken = 0.55 + 0.45 * vnoise(p.xy * 26.0);
  return (broad * 0.8 + fine * 0.5) * broken * exp(-range / reach) * smoothstep(0.0, 0.05, range);
}

void main() {
  vec2 q = (gl_FragCoord.xy / uSize * 2.0 - 1.0) * EXTENT;
  vec3 p = sphere(q);
  float mare = maria(p);

  float e = 2.0 * EXTENT / uSize.x;
  float h = relief(q, mare);
  vec2 slope = vec2(relief(q + vec2(e, 0.0), mare) - h, relief(q + vec2(0.0, e), mare) - h) / e;
  slope *= (1.0 + dot(q, q)) * 0.5;

  float albedo = 0.58 + 0.26 * (fbm(q * 3.3 + 3.0) - 0.5) + 0.14 * (fbm(q * 19.0) - 0.5);
  albedo *= mix(1.0, 0.35 + 0.2 * fbm(q * 5.0 + 31.0), mare);
${BRIGHT_CRATERS.map(([x, y, r, strength], index) => {
    const centre = onSphere(x, y);
    const [count, reach] = index === 0 ? [5.2, 0.62] : [3.4, 0.16];
    return `  albedo += ${f(0.5 * strength)} * rays(p, ${centre}, ${f(count)}, ${f(reach)}) + ${f(0.22 * strength)} * exp(-pow(length(p - ${centre}) / ${f(r * 1.5)}, 2.0));`;
  }).join("\n")}
  albedo += clamp(-h * 6.0, -0.03, 0.04);

  gl_FragColor = vec4(clamp(albedo, 0.0, 1.0), 0.5 + 0.5 * clamp(slope * 0.4, -1.0, 1.0), 1.0);
}
`;

const SKY = `${NOISE}
uniform sampler2D uSurface;
uniform vec2 uSize;
uniform float uScale;
uniform float uTime;
uniform float uRise;
uniform vec3 uMoon;
uniform vec3 uEarth;
uniform vec2 uDrift;
uniform vec2 uTilt;

const float EXTENT = 1.2;
const vec3 SUN = vec3(${f(SUN.x)}, ${f(SUN.y)}, ${f(SUN.z)});
const vec3 TYCHO = ${onSphere(TYCHO.x, TYCHO.y)};
const vec3 GOLD = vec3(1.0, 0.77, 0.34);

// Turns a direction seen from the camera into the Moon's own frame; the small tilt is the libration.
vec3 toMoon(vec3 v) {
  float ca = cos(uTilt.x), sa = sin(uTilt.x), cb = cos(uTilt.y), sb = sin(uTilt.y);
  v = vec3(ca * v.x + sa * v.z, v.y, ca * v.z - sa * v.x);
  return vec3(v.x, cb * v.y - sb * v.z, sb * v.y + cb * v.z);
}
vec3 fromMoon(vec3 v) {
  float ca = cos(uTilt.x), sa = sin(uTilt.x), cb = cos(uTilt.y), sb = sin(uTilt.y);
  v = vec3(v.x, cb * v.y + sb * v.z, cb * v.z - sb * v.y);
  return vec3(ca * v.x - sa * v.z, v.y, sa * v.x + ca * v.z);
}

vec3 stars(vec2 px, float cell, float seed, float size) {
  vec2 g = px / cell, id = floor(g);
  vec2 rnd = hash2(id + seed);
  float magnitude = pow(hash1(id * 1.3 + seed + 5.0), 7.0);
  float d = length(fract(g) - (0.2 + 0.6 * rnd)) * cell / uScale;
  float radius = size * (0.55 + 1.5 * magnitude);
  float twinkle = 0.72 + 0.28 * sin(uTime * (0.7 + 2.6 * rnd.x) + rnd.y * 40.0);
  float light = exp(-d * d / (radius * radius)) * (0.3 + 1.1 * magnitude) + exp(-d / (radius * 2.6)) * 0.22 * magnitude;
  vec3 tint = mix(vec3(0.74, 0.83, 1.0), vec3(1.0, 0.9, 0.76), step(0.72, rnd.y));
  return mix(vec3(1.0), tint, 0.6) * light * twinkle;
}

vec3 shootingStar(vec2 px) {
  float cycle = 9.0;
  float turn = floor(uTime / cycle), t = (uTime - turn * cycle) / 0.9;
  if (t > 1.0) return vec3(0.0);
  vec2 rnd = hash2(vec2(turn, 3.7));
  vec2 dir = normalize(vec2(-0.86 + 0.3 * rnd.y, -0.42));
  vec2 head = vec2(0.25 + 0.7 * rnd.x, 0.72 + 0.24 * rnd.y) * uSize + dir * t * 0.42 * uSize.y;
  vec2 rel = px - head;
  float along = -dot(rel, dir), across = abs(rel.x * dir.y - rel.y * dir.x);
  float tail = 0.2 * uSize.y;
  if (along < 0.0 || along > tail) return vec3(0.0);
  float width = uScale * (1.4 - along / tail);
  float light = exp(-across * across / (width * width)) * pow(1.0 - along / tail, 2.0) * sin(3.1416 * t);
  return vec3(0.86, 0.92, 1.0) * light;
}

vec3 moonSurface(vec2 d, out float lit) {
  float z = sqrt(max(1.0 - dot(d, d), 0.0));
  vec3 p = toMoon(vec3(d, z));
  vec2 q = p.xy / (1.0 + p.z);
  vec4 surface = texture2D(uSurface, q / EXTENT * 0.5 + 0.5);
  float s = dot(q, q);
  vec3 east = normalize(vec3(2.0 * (1.0 + s) - 4.0 * q.x * q.x, -4.0 * q.x * q.y, -4.0 * q.x));
  vec3 north = normalize(vec3(-4.0 * q.x * q.y, 2.0 * (1.0 + s) - 4.0 * q.y * q.y, -4.0 * q.y));
  vec2 slope = (surface.gb - 0.5) * 1.9;
  vec3 normal = normalize(p - slope.x * east - slope.y * north);

  vec3 sun = toMoon(normalize(SUN));
  float day = dot(p, sun);
  float mu0 = max(dot(normal, sun), 0.0), mu = max(z, 0.03);
  // Lunar soil scatters light back toward the Sun, so the lit disc stays bright right up to the limb.
  float light = mix(mu0, min(2.0 * mu0 / (mu0 + mu), 1.3), 0.6) * smoothstep(-0.07, 0.12, day);
  lit = smoothstep(-0.1, 0.25, day);

  float albedo = surface.r;
  vec3 tint = mix(vec3(0.8, 0.84, 0.94), vec3(1.0, 0.97, 0.92), smoothstep(0.28, 0.62, albedo));
  vec3 colour = albedo * tint * light * 1.42;
  colour += albedo * vec3(0.02, 0.032, 0.062) * (1.0 - lit);
  colour = pow(colour, vec3(0.4545));
  // A cool rim where the surface turns away from the camera.
  colour += vec3(0.3, 0.45, 0.8) * pow(1.0 - z, 5.0) * (0.08 + 0.22 * lit);
  return colour;
}

vec3 festival(vec2 px) {
  vec3 site = fromMoon(TYCHO);
  if (site.z < 0.1) return vec3(0.0);
  vec2 rel = (px - (uMoon.xy + site.xy * uMoon.z)) / uMoon.z;
  float d = length(rel);
  float glow = exp(-d * d / 0.00016) * 1.6 + exp(-d * d / 0.0024) * 0.55 + exp(-d / 0.075) * 0.16;
  vec3 colour = GOLD * glow * (0.86 + 0.14 * sin(uTime * 2.3));
  for (int i = 0; i < 7; i++) {
    vec2 rnd = hash2(vec2(float(i), 8.3));
    vec2 lamp = (rnd - 0.5) * 0.085;
    float spark = exp(-dot(rel - lamp, rel - lamp) / 0.000012) * (0.6 + 0.4 * sin(uTime * (1.5 + 3.0 * rnd.x) + rnd.y * 20.0));
    colour += mix(GOLD, vec3(1.0, 0.95, 0.86), rnd.y) * spark;
  }
  float outward = atan(site.y, site.x);
  for (int i = 0; i < 4; i++) {
    float n = float(i);
    float angle = outward + (n - 1.5) * 0.44 + 0.36 * sin(uTime * (0.21 + 0.06 * n) + n * 2.4);
    vec2 dir = vec2(cos(angle), sin(angle));
    float along = dot(rel, dir), across = abs(rel.x * dir.y - rel.y * dir.x);
    float width = 0.0035 + along * 0.06;
    float beam = (1.0 - smoothstep(width * 0.15, width, across)) * smoothstep(0.0, 0.02, along) * exp(-along / 0.3);
    colour += mix(GOLD, vec3(1.0, 0.94, 0.84), 0.35) * beam * 0.62;
  }
  return colour;
}

vec3 earth(vec2 d, out float lit) {
  float z = sqrt(max(1.0 - dot(d, d), 0.0));
  vec3 n = vec3(d, z);
  lit = smoothstep(-0.08, 0.3, dot(n, normalize(vec3(-0.72, 0.5, -0.62))));
  vec2 map = n.xy / (1.0 + n.z) * 2.4 + vec2(uTime * 0.004, 0.0);
  vec3 colour = mix(vec3(0.05, 0.2, 0.52), vec3(0.16, 0.36, 0.3), smoothstep(0.52, 0.62, fbm(map * 1.6 + 7.0)));
  colour = mix(colour, vec3(0.94, 0.96, 1.0), smoothstep(0.46, 0.74, fbm(map * 2.6 + vec2(uTime * 0.006, 3.0))));
  colour += vec3(0.25, 0.5, 1.0) * pow(1.0 - z, 3.0) * 0.8;
  return colour * lit * 1.15 + vec3(0.008, 0.014, 0.04);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uSize;

  vec3 colour = mix(vec3(0.027, 0.051, 0.141), vec3(0.008, 0.013, 0.043), smoothstep(0.0, 0.95, uv.y));
  vec2 wide = px / uSize.y;
  float band = exp(-pow((wide.y - 0.2 - wide.x * 0.3) * 2.1, 2.0));
  float cloud = fbm(wide * 2.4 + uDrift * 0.015 + 2.0);
  colour += vec3(0.04, 0.062, 0.13) * band * cloud * cloud * 1.5;

  vec3 light = stars(px + uDrift * uScale * 5.0, 22.0 * uScale, 3.0, 0.62);
  light += stars(px + uDrift * uScale * 11.0, 46.0 * uScale, 17.0, 0.85);
  light += stars(px + uDrift * uScale * 20.0, 104.0 * uScale, 41.0, 1.15) * 1.3;
  light += shootingStar(px);
  colour += light * uRise;

  vec2 fromEarth = (px - uEarth.xy) / uEarth.z;
  float earthDistance = length(fromEarth);
  if (earthDistance < 2.6) {
    float lit;
    vec3 body = earth(fromEarth / max(earthDistance, 1.0), lit);
    float edge = 1.0 - smoothstep(1.0 - 1.5 / uEarth.z, 1.0 + 1.5 / uEarth.z, earthDistance);
    float sunward = 0.25 + 0.75 * smoothstep(-0.4, 0.9, dot(fromEarth / max(earthDistance, 0.001), normalize(vec2(-0.72, 0.5))));
    vec3 air = vec3(0.24, 0.5, 1.0) * exp(-max(earthDistance - 1.0, 0.0) / 0.16) * 0.7 * sunward;
    colour = mix(colour + air * (1.0 - edge), body, edge);
  }

  vec2 fromCentre = (px - uMoon.xy) / uMoon.z;
  float range = length(fromCentre);
  float sunSide = 0.3 + 0.7 * smoothstep(-0.5, 0.9, dot(fromCentre / max(range, 0.001), normalize(SUN.xy)));
  float outside = max(range - 1.0, 0.0);
  vec3 halo = vec3(0.56, 0.7, 1.0) * (exp(-outside / 0.035) * 0.42 + exp(-outside / 0.2) * 0.16 + exp(-outside / 0.75) * 0.07) * sunSide;
  colour += halo * (0.35 + 0.65 * uRise);
  if (range < 1.0 + 2.0 / uMoon.z) {
    float lit;
    vec3 surface = moonSurface(fromCentre / max(range, 1.0), lit);
    float edge = 1.0 - smoothstep(1.0 - 1.5 / uMoon.z, 1.0 + 1.5 / uMoon.z, range);
    colour = mix(colour, surface, edge);
  }
  colour += festival(px) * uRise;

  // A little grain stops the dark gradients from banding on a large screen.
  colour += (hash1(px + fract(uTime) * 61.0) - 0.5) / 160.0;
  gl_FragColor = vec4(colour, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type);
    if (!shader || !program) return undefined;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn("Sky shader did not compile:", gl.getShaderInfoLog(shader));
      return undefined;
    }
    gl.attachShader(program, shader);
  }
  if (!program) return undefined;
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : undefined;
}

/** Draws the sky with a fragment shader. Returns undefined when WebGL is missing so the caller can fall back. */
export function createWebglSky(canvas: HTMLCanvasElement): SkyRenderer | undefined {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
  if (!gl) return undefined;
  const surfaceProgram = compile(gl, VERTEX, SURFACE);
  const skyProgram = compile(gl, VERTEX, SKY);
  if (!surfaceProgram || !skyProgram) return undefined;

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const size = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, window.innerWidth < 760 ? 1024 : 2048);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const target = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, target);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return undefined;
  gl.viewport(0, 0, size, size);
  gl.useProgram(surfaceProgram);
  gl.uniform2f(gl.getUniformLocation(surfaceProgram, "uSize"), size, size);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(target);
  gl.deleteProgram(surfaceProgram);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.useProgram(skyProgram);
  const uniform = (name: string) => gl.getUniformLocation(skyProgram, name);
  const uniforms = {
    size: uniform("uSize"), scale: uniform("uScale"), time: uniform("uTime"), rise: uniform("uRise"),
    moon: uniform("uMoon"), earth: uniform("uEarth"), drift: uniform("uDrift"), tilt: uniform("uTilt"),
  };
  gl.uniform1i(uniform("uSurface"), 0);
  let scale = 1;

  return {
    resize(width, height, nextScale) {
      scale = nextScale;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.size, canvas.width, canvas.height);
      gl.uniform1f(uniforms.scale, scale);
    },
    draw({ time, moon, earth, drift, rise }: Frame) {
      const flip = (disc: { x: number; y: number; r: number }) => [disc.x * scale, canvas.height - disc.y * scale, disc.r * scale] as const;
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(uniforms.rise, rise);
      gl.uniform3f(uniforms.moon, ...flip(moon));
      gl.uniform3f(uniforms.earth, ...flip(earth));
      gl.uniform2f(uniforms.drift, drift.x, -drift.y);
      // Libration: a slow nod and turn, plus a slight lean toward the pointer.
      gl.uniform2f(uniforms.tilt, 0.05 * Math.sin(time * 0.11) + 0.07 * drift.x, 0.035 * Math.sin(time * 0.083 + 1) + 0.05 * drift.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteProgram(skyProgram);
    },
  };
}
