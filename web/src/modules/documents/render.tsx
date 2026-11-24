import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Barcode } from "@/components/barcode";
import { cn, formatDateTime } from "@/lib/utils";
import { docTypeDef, pageMm, type DocLayout, type DocType, type SectionDef } from "./config";
import type { Block, DocData } from "./data";
import type { Letterhead } from "./api";

/**
 * Renders a document as real pages (paper size, margins, header, footer)
 * from a template layout and live data. Content is measured once off-screen
 * and split into pages: sections move whole to the next page when they don't
 * fit; tables split between rows and repeat their column headings. The same
 * pages are printed and exported to PDF, so screen, paper and PDF match.
 */
export const MM = 96 / 25.4;
const WIDE = new Set(["description", "formula", "check", "process", "name", "remark", "note", "spec", "material", "labelDescription"]);
const NARROW = new Set(["seq", "no", "lineNo"]);

interface Props {
  type: DocType;
  layout: DocLayout;
  letterhead: Letterhead | null;
  data: DocData;
  printedBy: string;
  printedAt?: Date;
  /** Display zoom of the pages (measurement and print / PDF are unaffected). */
  zoom?: number;
  pagesRef?: Ref<HTMLDivElement>;
}
type Item = { kind: "section"; key: string; rows?: [number, number]; cont?: boolean } | { kind: "notes" } | { kind: "signatures" };

export function DocumentPages(props: Props) {
  const { layout, data, type } = props;
  const def = docTypeDef(type);
  const [w, h] = pageMm(layout.page);
  const pad = layout.page.marginMm * MM;
  const contentW = w * MM - pad * 2;
  const measureRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Item[][] | null>(null);
  const sections = useMemo(
    () =>
      layout.sections
        .filter((s) => s.enabled)
        .map((s) => ({ s, def: def.sections.find((d) => d.key === s.key), block: data.blocks[s.key] }))
        .filter((x): x is { s: DocLayout["sections"][number]; def: SectionDef; block: Block } => !!x.def && !!x.block),
    [layout.sections, def, data.blocks],
  );
  const sig = useMemo(() => JSON.stringify([layout, data, props.letterhead]), [layout, data, props.letterhead]);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const height = (sel: string) => (root.querySelector(sel) as HTMLElement | null)?.offsetHeight ?? 0;
    const headerFirst = height("[data-m='header-first']");
    const headerOther = height("[data-m='header-other']");
    const footer = height("[data-m='footer']");
    const full = h * MM - pad * 2 - 4;
    const avail = (first: boolean) => full - footer - (first ? headerFirst : headerOther);
    const out: Item[][] = [[]];
    let first = true;
    let used = 0;
    const newPage = () => {
      out.push([]);
      first = false;
      used = 0;
    };
    const place = (need: number, item: Item) => {
      if (used > 0 && used + need > avail(first)) newPage();
      out[out.length - 1]!.push(item);
      used += need;
    };
    for (const { s, block } of sections) {
      const el = root.querySelector(`[data-m='sec-${s.key}']`) as HTMLElement | null;
      if (!el) continue;
      if (block.kind !== "table") {
        place(el.offsetHeight, { kind: "section", key: s.key });
        continue;
      }
      const title = height(`[data-m='sec-${s.key}'] [data-m='title']`);
      const head = height(`[data-m='sec-${s.key}'] thead`);
      const gap = el.offsetHeight - title - (el.querySelector("table") as HTMLElement).offsetHeight;
      const rowH = [...el.querySelectorAll("tbody tr")].map((r) => (r as HTMLElement).offsetHeight);
      if (!rowH.length) {
        place(el.offsetHeight, { kind: "section", key: s.key });
        continue;
      }
      let start = 0;
      let cont = false;
      while (start < rowH.length) {
        const base = title + head + gap;
        if (used > 0 && used + base + rowH[start]! > avail(first)) newPage();
        let end = start;
        let need = base;
        while (end < rowH.length && (end === start || used + need + rowH[end]! <= avail(first))) need += rowH[end++]!;
        out[out.length - 1]!.push({ kind: "section", key: s.key, rows: [start, end], cont });
        used += need;
        start = end;
        cont = true;
        if (start < rowH.length) newPage();
      }
    }
    if (layout.notes.text.trim()) place(height("[data-m='notes']"), { kind: "notes" });
    if (layout.signatures.length) place(height("[data-m='signatures']"), { kind: "signatures" });
    setPages(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, sections, h, pad]);

  const total = pages?.length ?? 1;
  return (
    <>
      {/* Off-screen measurement copy at the real content width. */}
      <div ref={measureRef} aria-hidden className={cn("doc-paper", `doc-accent-${layout.page.accent}`)} style={{ position: "absolute", left: -100_000, top: 0, width: contentW, fontSize: `${layout.page.fontSizePt}pt`, visibility: "hidden" }}>
        <div data-m="header-first" className="flow-root">
          <Header {...props} first />
        </div>
        <div data-m="header-other" className="flow-root">
          <Header {...props} first={false} />
        </div>
        <div data-m="footer" className="flow-root">
          <Footer {...props} page={1} pages={1} />
        </div>
        {sections.map(({ s, def: d, block }) => (
          <div key={s.key} data-m={`sec-${s.key}`} className="flow-root">
            <Section title={s.title || d.label} def={d} columns={s.columns} block={block} landscape={layout.page.orientation === "landscape"} density={layout.page.density} />
          </div>
        ))}
        <div data-m="notes" className="flow-root">
          <Notes layout={layout} />
        </div>
        <div data-m="signatures" className="flow-root">
          <Signatures layout={layout} />
        </div>
      </div>
      <div ref={props.pagesRef} className="flex flex-col items-center gap-4" style={{ zoom: props.zoom ?? 1 }}>
      {(pages ?? [[]]).map((items, i) => (
        <div
          key={i}
          className={cn("doc-paper doc-page", `doc-accent-${layout.page.accent}`)}
          style={{ width: w * MM, height: h * MM, padding: pad, fontSize: `${layout.page.fontSizePt}pt` }}
          data-doc-page
        >
          <div className="flex h-full flex-col">
            <Header {...props} first={i === 0} />
            <div className="min-h-0 flex-1 overflow-hidden">
              {items.map((it, k) => {
                if (it.kind === "notes") return <Notes key={k} layout={layout} />;
                if (it.kind === "signatures") return <Signatures key={k} layout={layout} />;
                const x = sections.find((y) => y.s.key === it.key);
                if (!x) return null;
                const block = it.rows && x.block.kind === "table" ? { ...x.block, rows: x.block.rows.slice(it.rows[0], it.rows[1]) } : x.block;
                return <Section key={k} title={`${x.s.title || x.def.label}${it.cont ? " (continued)" : ""}`} def={x.def} columns={x.s.columns} block={block} landscape={layout.page.orientation === "landscape"} density={layout.page.density} />;
              })}
            </div>
            <Footer {...props} page={i + 1} pages={total} />
          </div>
        </div>
      ))}
      </div>
    </>
  );
}

function Header({ layout, letterhead, data, first }: Props & { first: boolean }) {
  const hd = layout.header;
  if (!first && hd.repeat === "first")
    return (
      <div className="doc-running mb-[3mm] flex justify-between border-b pb-[1.5mm] text-[0.85em]">
        <span className="font-semibold">{hd.title}</span>
        <span>{data.docNo}</span>
      </div>
    );
  const logo = hd.showLogo && letterhead?.logo ? <img src={letterhead.logo} alt="" className="h-[16mm] w-auto max-w-[45mm] object-contain" /> : null;
  const company = (
    <div className={cn("min-w-0", hd.logoAlign === "right" && "text-right")}>
      {hd.showCompanyName && <p className="text-[1.35em] leading-tight font-bold">{letterhead?.companyName || "Company name (set in Letterhead)"}</p>}
      {hd.showRegistration && letterhead?.registrationNo && <p className="doc-muted text-[0.85em]">{letterhead.registrationNo}</p>}
      {hd.showAddress && letterhead?.address && <p className="doc-muted text-[0.85em] whitespace-pre-line">{letterhead.address}</p>}
      {hd.showContact && (letterhead?.phone || letterhead?.email || letterhead?.website) && (
        <p className="doc-muted text-[0.85em]">{[letterhead?.phone && `Tel ${letterhead.phone}`, letterhead?.email, letterhead?.website].filter(Boolean).join(" · ")}</p>
      )}
    </div>
  );
  const brand = (
    <div className={cn("flex min-w-0 items-start gap-[3mm]", hd.logoAlign === "right" && "flex-row-reverse")}>
      {logo}
      {company}
    </div>
  );
  const title = (
    <div className={cn("shrink-0", hd.logoAlign === "right" ? "text-left" : "text-right")}>
      <p className="doc-accent-text text-[1.6em] leading-tight font-bold">{hd.title}</p>
      {hd.subtitle && <p className="doc-muted text-[0.9em]">{hd.subtitle}</p>}
      {(hd.showDocNo || hd.showDocDate) && (
        <table className={cn("mt-[1mm] text-[0.9em]", hd.logoAlign === "right" ? "mr-auto" : "ml-auto")}>
          <tbody>
            {hd.showDocNo && (
              <tr>
                <td className="doc-muted pr-[2mm]">No.</td>
                <td className="font-semibold">{data.docNo}</td>
              </tr>
            )}
            {hd.showDocDate && (
              <tr>
                <td className="doc-muted pr-[2mm]">Date</td>
                <td>{data.docDate}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {hd.showBarcode && data.barcode && (
        <div className={cn("doc-barcode mt-[1mm] h-[13mm] w-[48mm]", hd.logoAlign === "right" ? "mr-auto" : "ml-auto")}>
          <Barcode value={data.barcode} scale={2} height={8} />
        </div>
      )}
    </div>
  );
  return (
    <div className={cn("mb-[4mm]", hd.divider && "doc-accent-border border-b-2 pb-[3mm]")}>
      <div className="flex items-start justify-between gap-[5mm]">
        {hd.logoAlign === "right" ? (
          <>
            {title}
            {brand}
          </>
        ) : (
          <>
            {brand}
            {title}
          </>
        )}
      </div>
      {hd.extraText && <p className="mt-[2mm] text-[0.9em] whitespace-pre-line">{hd.extraText}</p>}
    </div>
  );
}

function fill(tpl: string, p: Props & { page: number; pages: number }) {
  return tpl
    .replaceAll("{docNo}", p.data.docNo)
    .replaceAll("{printedBy}", p.printedBy)
    .replaceAll("{printedAt}", formatDateTime(p.printedAt ?? new Date()))
    .replaceAll("{page}", String(p.page))
    .replaceAll("{pages}", String(p.pages))
    .replaceAll("{company}", p.letterhead?.companyName ?? "");
}

function Footer(p: Props & { page: number; pages: number }) {
  const f = p.layout.footer;
  const right = [fill(f.right, p), f.showPageNumbers ? `Page ${p.page} of ${p.pages}` : ""].filter(Boolean).join("  ·  ");
  return (
    <div className={cn("doc-muted mt-[3mm] grid grid-cols-3 gap-[3mm] pt-[1.5mm] text-[0.8em]", f.divider && "border-t")}>
      <span className="truncate">{fill(f.left, p)}</span>
      <span className="truncate text-center">{fill(f.center, p)}</span>
      <span className="truncate text-right">{right}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <p data-m="title" className="doc-accent-text mb-[1.5mm] text-[0.95em] font-bold tracking-wide uppercase">
      {children}
    </p>
  );
}

function Section({ title, def, columns, block, landscape, density }: { title: string; def: SectionDef; columns?: string[]; block: Block; landscape: boolean; density: "compact" | "comfortable" }) {
  const cell = density === "compact" ? "px-[1.5mm] py-[0.8mm]" : "px-[2mm] py-[1.4mm]";
  return (
    <div className="pb-[4mm]">
      <SectionTitle>{title}</SectionTitle>
      {block.kind === "fields" && (
        <div className={cn("doc-grid grid border-t border-l", landscape ? "grid-cols-3" : "grid-cols-2")}>
          {block.items.map((it) => (
            <div key={it.label} className={cn("flex gap-[2mm] border-r border-b", cell)}>
              <span className="doc-muted w-[34%] shrink-0">{it.label}</span>
              <span className="min-w-0 font-medium break-words whitespace-pre-line">{it.value}</span>
            </div>
          ))}
        </div>
      )}
      {block.kind === "text" && <p className="whitespace-pre-line">{block.text}</p>}
      {block.kind === "image" && (
        <figure className="flex flex-col items-center">
          <div className="doc-grid flex h-[55mm] w-full items-center justify-center border">
            {block.src ? <img src={block.src} alt={block.caption} className="max-h-full max-w-full object-contain" /> : <span className="doc-muted">No artwork preview</span>}
          </div>
          <figcaption className="doc-muted mt-[1mm] text-[0.85em]">{block.caption}</figcaption>
        </figure>
      )}
      {block.kind === "table" && <Table def={def} columns={columns} rows={block.rows} cell={cell} />}
    </div>
  );
}

function Table({ def, columns, rows, cell }: { def: SectionDef; columns?: string[]; rows: Record<string, string>[]; cell: string }) {
  const cols = (columns ?? def.columns!.map((c) => c.key)).map((k) => def.columns!.find((c) => c.key === k)).filter((c): c is NonNullable<typeof c> => !!c);
  const weight = (k: string, blank?: boolean) => (NARROW.has(k) ? 0.45 : WIDE.has(k) ? 2.6 : blank ? 1.6 : 1.15);
  const total = cols.reduce((a, c) => a + weight(c.key, c.blank), 0);
  return (
    <table className="doc-table w-full table-fixed border-collapse">
      <colgroup>
        {cols.map((c) => (
          <col key={c.key} style={{ width: `${(weight(c.key, c.blank) / total) * 100}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} className={cn("border text-left font-semibold", cell, c.align === "right" && "text-right", c.align === "center" && "text-center")}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {!rows.length && (
          <tr>
            <td colSpan={cols.length} className={cn("doc-muted border text-center", cell)}>
              None
            </td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map((c) => (
              <td key={c.key} className={cn("border align-top break-words", cell, c.blank && "h-[8mm]", c.align === "right" && "text-right tabular-nums", c.align === "center" && "text-center")}>
                {r[c.key] ?? ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Notes({ layout }: { layout: DocLayout }) {
  if (!layout.notes.text.trim()) return null;
  return (
    <div className="pb-[4mm]">
      {layout.notes.title && <SectionTitle>{layout.notes.title}</SectionTitle>}
      <p className="whitespace-pre-line">{layout.notes.text}</p>
    </div>
  );
}

function Signatures({ layout }: { layout: DocLayout }) {
  if (!layout.signatures.length) return null;
  return (
    <div className="grid gap-[6mm] pt-[8mm] pb-[2mm]" style={{ gridTemplateColumns: `repeat(${layout.signatures.length}, minmax(0, 1fr))` }}>
      {layout.signatures.map((s, i) => (
        <div key={i} className="text-[0.9em]">
          <div className="h-[14mm] border-b" />
          <p className="mt-[1mm] font-semibold">{s.label}</p>
          <p className="doc-muted">Name / date</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Print and PDF
// ---------------------------------------------------------------------------

/** Copies of the rendered pages (canvases turned into images) in a container attached to <body>. */
function detachPages(source: HTMLElement, className: string) {
  const box = document.createElement("div");
  box.className = className;
  for (const page of source.querySelectorAll<HTMLElement>("[data-doc-page]")) {
    const copy = page.cloneNode(true) as HTMLElement;
    const canvases = page.querySelectorAll("canvas");
    copy.querySelectorAll("canvas").forEach((c, i) => {
      const img = document.createElement("img");
      img.src = canvases[i]!.toDataURL("image/png");
      img.className = "max-w-full";
      c.replaceWith(img);
    });
    box.appendChild(copy);
  }
  document.body.appendChild(box);
  return box;
}

export function printPages(source: HTMLElement, layout: DocLayout) {
  const [w, h] = pageMm(layout.page);
  const style = document.createElement("style");
  style.textContent = `@page { size: ${w}mm ${h}mm; margin: 0; }`;
  document.head.appendChild(style);
  const box = detachPages(source, "print-docs");
  document.body.classList.add("printing-doc");
  const done = () => {
    document.body.classList.remove("printing-doc");
    box.remove();
    style.remove();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  // Images in the copies must be decoded before the print snapshot.
  void Promise.all([...box.querySelectorAll("img")].map((i) => i.decode().catch(() => undefined))).then(() => window.print());
}

export async function downloadPdf(source: HTMLElement, layout: DocLayout, fileName: string) {
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  const [w, h] = pageMm(layout.page);
  const box = detachPages(source, "doc-export");
  try {
    await Promise.all([...box.querySelectorAll("img")].map((i) => i.decode().catch(() => undefined)));
    const pdf = new jsPDF({ orientation: w > h ? "landscape" : "portrait", unit: "mm", format: [w, h], compress: true });
    const pages = [...box.querySelectorAll<HTMLElement>("[data-doc-page]")];
    for (const [i, page] of pages.entries()) {
      const canvas = await toCanvas(page, { pixelRatio: 2, skipFonts: true, backgroundColor: "#ffffff" });
      if (i > 0) pdf.addPage([w, h], w > h ? "landscape" : "portrait");
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, w, h, undefined, "FAST");
    }
    pdf.save(`${fileName.replace(/[^\w.-]+/g, "_")}.pdf`);
  } finally {
    box.remove();
  }
}
