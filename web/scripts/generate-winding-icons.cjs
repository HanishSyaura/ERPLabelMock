/**
 * Winding position pictures in the TBS chart style (line art):
 *   1–4 wound out: roll face on the left; the grey liner band wraps over the top of
 *                  the roll and hangs down on the right, white labels outside.
 *   5–8 wound in:  roll seen from the other end (face on the right); a thin band
 *                  leaves underneath and runs to the lower left, labels inside.
 *   Copy on the label: 1/5 upright, 2/6 upside down, 3/7 turned right, 4/8 turned left
 *   (relative to the web as it unwinds).
 * Writes position-1.svg … position-8.svg into the folder given as argv[2]:
 *   node web/scripts/generate-winding-icons.cjs web/src/modules/bom/winding
 */
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
fs.mkdirSync(dir, { recursive: true });

const INK = "#1a1a1a";
const LINER = "#a8a8a8";
const LABEL = "#ffffff";
const CORE = "#9b9b9b";
const ROT = [0, 180, 90, -90];
const deg = (r) => (r * 180) / Math.PI;
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const f = (n) => Number(n.toFixed(2));

/** White labels along a straight run of web from `a` to `b` (centre line). */
function labelsAlong(a, b, ts, w, h, rot, fontScale = 0.7) {
  const angle = deg(Math.atan2(b[1] - a[1], b[0] - a[0])) - 90; // long axis vs straight down
  return ts
    .map((t) => {
      const [x, y] = lerp(a, b, t);
      return (
        `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(angle)})">` +
        `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="1" fill="${LABEL}" stroke="${INK}" stroke-width="0.9"/>` +
        `<text transform="rotate(${rot})" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif" font-size="${f(h * fontScale)}" font-weight="700" fill="${INK}">A</text>` +
        `</g>`
      );
    })
    .join("");
}

/** Roll face with the core: grey core with the thin white rim on its inner side. */
function face(cx, cy, rx, ry, rimSide) {
  const s = rimSide === "right" ? 1 : -1;
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#ffffff" stroke="${INK}" stroke-width="2"/>` +
    `<ellipse cx="${f(cx - s * 1.5)}" cy="${cy}" rx="${f(rx * 0.4)}" ry="${f(ry * 0.56)}" fill="${CORE}" stroke="${INK}" stroke-width="2"/>` +
    `<path d="M${f(cx - s * 1.5 + s * rx * 0.12)} ${f(cy - ry * 0.5)} A${f(rx * 0.22)} ${f(ry * 0.5)} 0 0 ${s > 0 ? 1 : 0} ${f(cx - s * 1.5 + s * rx * 0.12)} ${f(cy + ry * 0.5)}" fill="#ffffff" stroke="${INK}" stroke-width="1.2"/>`
  );
}

function woundOut(rot) {
  const cx = 28, cy = 42, rx = 21, ry = 30, depth = 22;
  const bx = cx + depth;
  // Roll body (the wound web), white; the band covers its top and right side.
  const body = `<path d="M${cx} ${cy - ry} H${bx} A${rx} ${ry} 0 0 1 ${bx} ${cy + ry} H${cx}" fill="#ffffff" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
  // Liner band: over the top of the roll, round the right side, then hanging down-right.
  const band =
    `<path d="M${cx + 4} ${cy - ry} H${bx} C${bx + 16} ${cy - ry} ${bx + 22} ${cy - 8} ${bx + 21} ${cy + 6} ` +
    `L${bx + 29} ${cy + 64} L${bx + 12} ${cy + 67} L${bx + 4} ${cy + 12} C${bx + 3} ${cy - 6} ${bx - 6} ${cy - ry + 2} ${cx + 4} ${cy - ry} Z" ` +
    `fill="${LINER}" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
  // Labels on the roll top (seen edge-on, blank) and on the hanging web.
  const top =
    `<rect x="${cx + 13}" y="${cy - ry + 1.5}" width="10" height="5" rx="1" fill="${LABEL}" stroke="${INK}" stroke-width="0.9" transform="rotate(-4 ${cx + 18} ${cy - ry + 4})"/>` +
    `<rect x="${bx + 3}" y="${cy - ry + 6}" width="11" height="9" rx="1" fill="${LABEL}" stroke="${INK}" stroke-width="0.9" transform="rotate(14 ${bx + 8} ${cy - ry + 10})"/>`;
  const hangTop = [bx + 12.5, cy + 9];
  const hangBottom = [bx + 20.5, cy + 65.5];
  const labels = labelsAlong(hangTop, hangBottom, [0.22, 0.5, 0.78], 13.5, 12.5, rot);
  return body + face(cx, cy, rx, ry, "right") + band + top + labels;
}

function woundIn(rot) {
  const cx = 68, cy = 31, rx = 18, ry = 25, depth = 22;
  const bx = cx - depth;
  // Band (as wide as on 1–4) from under the roll to the lower left; drawn first so the roll covers its start.
  // The band starts inside the roll outline so the roll hides its start: it reads as coming off the roll.
  const top = [bx + 12, cy + ry - 8], bottom = [15, 100], half = 10;
  const dx = bottom[0] - top[0], dy = bottom[1] - top[1], len = Math.hypot(dx, dy);
  const px = (-dy / len) * half, py = (dx / len) * half; // perpendicular, half the band width
  const tl = [f(top[0] - px), f(top[1] - py)], tr = [f(top[0] + px), f(top[1] + py)];
  const bl = [f(bottom[0] - px), f(bottom[1] - py)], br = [f(bottom[0] + px), f(bottom[1] + py)];
  const band = `<path d="M${tl} L${tr} L${br} L${bl} Z" fill="${LINER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`;
  const labels = labelsAlong(lerp(tl, tr, 0.5), lerp(bl, br, 0.5), [0.4, 0.645, 0.89], 13, 12, rot, 0.7);
  const body = `<path d="M${cx} ${cy - ry} H${bx} A${rx} ${ry} 0 0 0 ${bx} ${cy + ry} H${cx}" fill="#ffffff" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>`;
  return band + labels + body + face(cx, cy, rx, ry, "left");
}

function svg(p) {
  const outward = p <= 4;
  const rot = ROT[(p - 1) % 4];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 112" width="96" height="112">
  <title>Winding position ${p} – ${outward ? "wound out (labels outside)" : "wound in (labels inside)"}</title>
  <rect width="96" height="112" fill="#ffffff"/>
  ${outward ? woundOut(rot) : woundIn(rot)}
</svg>
`;
}

for (let p = 1; p <= 8; p++) fs.writeFileSync(path.join(dir, `position-${p}.svg`), svg(p));
console.log("written 8 files to", dir);
