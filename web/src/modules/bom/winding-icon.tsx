import p1 from "./winding/position-1.svg";
import p2 from "./winding/position-2.svg";
import p3 from "./winding/position-3.svg";
import p4 from "./winding/position-4.svg";
import p5 from "./winding/position-5.svg";
import p6 from "./winding/position-6.svg";
import p7 from "./winding/position-7.svg";
import p8 from "./winding/position-8.svg";

/**
 * Winding position (printing direction) pictures in the TBS chart style, one
 * file per position (./winding/position-N.svg, made by
 * web/scripts/generate-winding-icons.cjs):
 * 1–4 wound out – the liner band wraps over the roll and hangs down on the
 * right, labels outside; 5–8 wound in – roll seen from the other end, a thin
 * band leaves underneath to the lower left, labels inside. Copy: 1/5 upright,
 * 2/6 upside down, 3/7 turned right, 4/8 turned left.
 */
const IMAGES: Record<number, string> = { 1: p1, 2: p2, 3: p3, 4: p4, 5: p5, 6: p6, 7: p7, 8: p8 };

export function WindingIcon({ position, className }: { position: number; className?: string }) {
  const src = IMAGES[position];
  if (!src) return null;
  return <img src={src} alt={`Winding position ${position}: ${position <= 4 ? "wound out" : "wound in"}`} className={className} draggable={false} />;
}
