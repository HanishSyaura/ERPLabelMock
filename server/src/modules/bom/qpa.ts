/**
 * QPA (quantity per assembly) on the Master Card: how much of each Son Code
 * part one finished label (1 PCS) uses, in the part's own unit. Calculated
 * where a rule exists, otherwise taken from the BOM quantity; a Manual QPA
 * always wins. Every result carries the formula with the numbers used, so it
 * can be checked with the customer.
 *
 * Rules (assumptions to confirm with the client):
 * - Feed length = web travel per die repeat (mm). Default: the die's repeat.
 * - Feed UPS = labels per feed = die across × around. Actual UPS defaults to
 *   Feed UPS; enter it lower when some positions are not used.
 * - Web parts in M2:  QPA = width (mm) × feed length (mm) ÷ actual UPS ÷ 1,000,000
 * - Web parts in M:   QPA = feed length (mm) ÷ actual UPS ÷ 1,000
 * - Core (category kind CORE):        QPA = 1 ÷ labels per roll
 * - Packaging (kind PACKAGING):       QPA = 1 ÷ (labels per roll × rolls per carton)
 * - Anything else (ink KG, foil roll…): BOM quantity, or Manual QPA.
 * Width = the Master Card line width, else the part's width in Part Master.
 */

export interface QpaLineInput {
  sonCode: string;
  materialCode: string;
  materialDescription: string;
  uom: string;
  kind: string | null;
  bomQty: number | null;
  partWidthMm: number | null;
  widthMm?: number | null;
  lengthMm?: number | null;
  heightMm?: number | null;
  manualQpa?: number | null;
}

export interface DieInput {
  feedLengthMm: number | null;
  actualUps: number | null;
}

export interface QpaLine {
  sonCode: string;
  materialCode: string;
  materialDescription: string;
  uom: string;
  widthMm: number | null;
  lengthMm: number | null;
  heightMm: number | null;
  bomQty: number | null;
  calculated: number | null;
  /** How the calculated value was reached, with numbers. */
  formula: string;
  manualQpa: number | null;
  qpa: number | null;
  source: "MANUAL" | "CALCULATED" | "BOM" | "MISSING";
}

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : round(n).toLocaleString("en-US", { maximumFractionDigits: 6 }));

/** Die Cut Spec: feed length, feed / actual UPS and web length per label. */
export function dieSpec(input: { feedLengthMm?: number | null; feedUps?: number | null; actualUps?: number | null; die?: { across: number; around: number; repeatMm: number | null } | null }) {
  const feedLengthMm = input.feedLengthMm ?? input.die?.repeatMm ?? null;
  const feedUps = input.feedUps ?? (input.die ? input.die.across * input.die.around : null);
  const actualUps = input.actualUps ?? feedUps;
  const qpa = feedLengthMm && actualUps ? round(feedLengthMm / actualUps) : null;
  const formula =
    feedLengthMm && actualUps
      ? `Feed length ${fmt(feedLengthMm)} mm ÷ actual UPS ${fmt(actualUps)} = ${fmt(qpa!)} mm of web per label`
      : "Needs the feed length and the UPS (choose a die, or enter them)";
  return {
    feedLengthMm,
    feedLengthFrom: input.feedLengthMm != null ? "card" : input.die?.repeatMm != null ? "die repeat" : null,
    feedUps,
    feedUpsFormula: input.feedUps == null && input.die ? `Die ${input.die.across} across × ${input.die.around} around = ${input.die.across * input.die.around}` : null,
    actualUps,
    qpa,
    formula,
  };
}

export function qpaLines(lines: QpaLineInput[], die: DieInput, spec: { labelsPerRoll?: number | null; rollsPerCarton?: number | null }): QpaLine[] {
  return lines.map((l) => {
    const width = l.widthMm ?? l.partWidthMm ?? null;
    let calculated: number | null = null;
    let formula: string;
    const uom = l.uom.toUpperCase();
    if (l.kind === "CORE") {
      if (spec.labelsPerRoll) {
        calculated = 1 / spec.labelsPerRoll;
        formula = `1 core ÷ ${fmt(spec.labelsPerRoll)} labels per roll = ${fmt(calculated)} per label`;
      } else formula = "Core: needs labels per roll on the Master Card";
    } else if (l.kind === "PACKAGING") {
      if (spec.labelsPerRoll && spec.rollsPerCarton) {
        calculated = 1 / (spec.labelsPerRoll * spec.rollsPerCarton);
        formula = `1 carton ÷ (${fmt(spec.labelsPerRoll)} labels per roll × ${fmt(spec.rollsPerCarton)} rolls per carton) = ${fmt(calculated)} per label`;
      } else formula = "Packaging: needs labels per roll and rolls per carton on the Master Card";
    } else if (uom === "M2") {
      if (width && die.feedLengthMm && die.actualUps) {
        calculated = (width * die.feedLengthMm) / die.actualUps / 1_000_000;
        formula = `Width ${fmt(width)} mm × feed length ${fmt(die.feedLengthMm)} mm ÷ ${fmt(die.actualUps)} UPS ÷ 1,000,000 = ${fmt(calculated)} m² per label`;
      } else formula = `m²: needs ${[!width && "the width", !die.feedLengthMm && "the feed length", !die.actualUps && "the UPS"].filter(Boolean).join(", ")}`;
    } else if (uom === "M") {
      if (die.feedLengthMm && die.actualUps) {
        calculated = die.feedLengthMm / die.actualUps / 1_000;
        formula = `Feed length ${fmt(die.feedLengthMm)} mm ÷ ${fmt(die.actualUps)} UPS ÷ 1,000 = ${fmt(calculated)} m per label`;
      } else formula = "m: needs the feed length and the UPS";
    } else {
      formula = `No calculation rule for ${uom}: uses the BOM quantity or Manual QPA`;
    }
    if (calculated !== null) calculated = round(calculated);
    const manual = l.manualQpa ?? null;
    const qpa = manual ?? calculated ?? l.bomQty ?? null;
    return {
      sonCode: l.sonCode,
      materialCode: l.materialCode,
      materialDescription: l.materialDescription,
      uom: l.uom,
      widthMm: width,
      lengthMm: l.lengthMm ?? null,
      heightMm: l.heightMm ?? null,
      bomQty: l.bomQty,
      calculated,
      formula,
      manualQpa: manual,
      qpa,
      source: manual != null ? "MANUAL" : calculated != null ? "CALCULATED" : l.bomQty != null ? "BOM" : "MISSING",
    };
  });
}
