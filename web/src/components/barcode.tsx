import { Printer } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Button, Dialog } from "./ui";

/**
 * Code 128 (default) or QR barcode drawn on a canvas. The value is only the
 * identifier (machine code / Work Order number): never editable production data.
 */
export function Barcode({ value, kind = "code128", scale = 3, height = 14 }: { value: string; kind?: "code128" | "qrcode"; scale?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    // The barcode library is large: load it only when a barcode is shown.
    void import("bwip-js/browser").then(({ toCanvas }) => {
      if (cancelled || !ref.current) return;
      try {
        toCanvas(ref.current, { bcid: kind, text: value, scale, height: kind === "qrcode" ? undefined : height, includetext: kind !== "qrcode", textxalign: "center", backgroundcolor: "FFFFFF" });
      } catch {
        /* invalid value: leave blank */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [value, kind, scale, height]);
  return <canvas ref={ref} className="max-w-full" aria-label={`Barcode ${value}`} />;
}

/** Print dialog for barcode labels (machine label, Work Order traveller). */
export function BarcodePrintDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" icon={<Printer className="size-4" />} onClick={() => window.print()}>
            Print
          </Button>
        </>
      }
    >
      <div className="print-area rounded-lg border border-line bg-white p-6 text-black">{children}</div>
    </Dialog>
  );
}
