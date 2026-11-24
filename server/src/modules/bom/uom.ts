/**
 * Units of measure available for materials and Son Codes. No single unit is
 * imposed: each material / Son Code line carries its own. Extend this list
 * when the factory confirms more units (open question D in the plan).
 */
export const UOMS = [
  { code: "PCS", label: "Pieces" },
  { code: "ROLL", label: "Rolls" },
  { code: "M", label: "Metres" },
  { code: "RM", label: "Running metres" },
  { code: "M2", label: "Square metres" },
  { code: "SHEET", label: "Sheets" },
  { code: "KG", label: "Kilograms" },
  { code: "G", label: "Grams" },
  { code: "L", label: "Litres" },
  { code: "SET", label: "Sets" },
  { code: "BOX", label: "Boxes" },
  { code: "CTN", label: "Cartons" },
] as const;

export const UOM_CODES = UOMS.map((u) => u.code) as [string, ...string[]];
