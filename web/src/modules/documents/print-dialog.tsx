import { useQuery } from "@tanstack/react-query";
import { Download, FileText, Printer, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ErrorState, LoadingState } from "@/components/common";
import { Button, Dialog, Select } from "@/components/ui";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useDocumentTemplates, useLetterhead } from "./api";
import { docTypeDef, normalizeLayout, pageMm, type DocType } from "./config";
import { loadDocument } from "./data";
import { DocumentPages, downloadPdf, MM, printPages } from "./render";

/** "Print" button for a record: opens the preview with its document template. */
export function PrintDocumentButton({ type, id, label = "Print", variant }: { type: DocType; id: string; label?: string; variant?: "primary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} icon={<Printer className="size-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <DocumentPrintDialog type={type} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

export function DocumentPrintDialog({ type, id, onClose }: { type: DocType; id: string; onClose: () => void }) {
  const { session, can } = useAuth();
  const toast = useToast();
  const def = docTypeDef(type);
  const templates = useDocumentTemplates({ docType: type, status: "ACTIVE" });
  const letterhead = useLetterhead();
  const data = useQuery({ queryKey: ["documents", "data", type, id], queryFn: () => loadDocument(type, id), staleTime: 0 });
  const [templateId, setTemplateId] = useState<string>("");
  const chosen = templates.data?.find((t) => t.id === templateId) ?? templates.data?.find((t) => t.isDefault) ?? templates.data?.[0];
  const layout = normalizeLayout(type, chosen?.layout);
  const pagesRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.8);
  const [busy, setBusy] = useState<"pdf" | null>(null);
  const [w] = pageMm(layout.page);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => setZoom(Math.min(1, Math.max(0.3, (el.clientWidth - 32) / (w * MM))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, data.isSuccess]);

  const ready = data.isSuccess && letterhead.isSuccess && templates.isSuccess;
  const pdf = async () => {
    if (!pagesRef.current || !data.data) return;
    setBusy("pdf");
    try {
      await downloadPdf(pagesRef.current, layout, `${def.label} ${data.data.docNo}`);
    } catch (e) {
      toast.error(`The PDF could not be made: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`${def.label}${data.data ? ` – ${data.data.docNo}` : ""}`}
      description="Preview with the document template. Print sends it to any printer (or Save as PDF); Download PDF saves the same pages as a file."
      footer={
        <>
          {can("system.documents.manage") && (
            <Link to={`/system/document-templates?type=${type}${chosen ? `&id=${chosen.id}` : ""}`} className="mr-auto inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
              <Settings2 className="size-4" /> Design this template
            </Link>
          )}
          <Button onClick={onClose}>Close</Button>
          <Button icon={<Download className="size-4" />} disabled={!ready} loading={busy === "pdf"} onClick={() => void pdf()}>
            Download PDF
          </Button>
          <Button variant="primary" icon={<Printer className="size-4" />} disabled={!ready} onClick={() => pagesRef.current && printPages(pagesRef.current, layout)}>
            Print
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <FileText className="size-4 text-muted" />
        <label className="flex items-center gap-2">
          <span className="text-muted">Template</span>
          <Select value={chosen?.id ?? ""} onChange={(e) => setTemplateId(e.target.value)} className="w-64" disabled={!templates.data?.length}>
            {!templates.data?.length && <option value="">Standard (built-in)</option>}
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isDefault ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </label>
        <span className="text-muted">
          {layout.page.size} {layout.page.orientation}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))} aria-label="Zoom out">
            −
          </Button>
          <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))} aria-label="Zoom in">
            +
          </Button>
        </div>
      </div>
      <div ref={boxRef} className="relative min-w-0 overflow-auto rounded-lg bg-neutral-soft p-4" style={{ height: "62vh" }}>
        {data.error ? (
          <ErrorState error={data.error} onRetry={() => void data.refetch()} />
        ) : !ready ? (
          <LoadingState label="Preparing the document…" />
        ) : (
          <DocumentPages type={type} layout={layout} letterhead={letterhead.data ?? null} data={data.data} printedBy={session?.user.fullName ?? ""} zoom={zoom} pagesRef={pagesRef} />
        )}
      </div>
    </Dialog>
  );
}
