import { Camera, Keyboard, ScanLine, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui";

/**
 * Scan input for industrial handhelds. Zebra / Honeywell scanners in
 * keyboard-wedge mode type the code and press Enter, so the field stays
 * focused with the soft keyboard hidden (inputMode="none"). "Type" shows the
 * keyboard for manual entry; "Camera" uses the device camera where the
 * browser supports barcode detection (needs HTTPS or localhost).
 */
export function ScanBox({ label, placeholder, onScan, busy, autoFocus = true }: { label: string; placeholder: string; onScan: (code: string) => void; busy?: boolean; autoFocus?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [typing, setTyping] = useState(false);
  const [camera, setCamera] = useState(false);

  // Keep focus on the scan field (a scanner types into whatever is focused).
  useEffect(() => {
    if (!autoFocus || camera) return;
    const t = setInterval(() => {
      const active = document.activeElement;
      if (ref.current && active !== ref.current && (active === document.body || active === null)) ref.current.focus();
    }, 700);
    ref.current?.focus();
    return () => clearInterval(t);
  }, [autoFocus, camera]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const code = value.trim();
    if (!code || busy) return;
    setValue("");
    onScan(code);
  };

  return (
    <div>
      <form onSubmit={submit} className="rounded-2xl border-2 border-dashed border-primary/60 bg-primary-soft/40 p-4">
        <label className="mb-2 flex items-center gap-2 text-base font-semibold">
          <ScanLine className="size-6 text-primary" /> {label}
        </label>
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={typing ? "text" : "none"}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={busy}
          className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-xl font-semibold tracking-wide focus:border-focus focus:ring-2 focus:ring-focus/30 focus:outline-none"
        />
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button
            size="lg"
            onClick={() => {
              setTyping((t) => !t);
              setTimeout(() => ref.current?.focus(), 50);
            }}
            icon={<Keyboard className="size-5" />}
          >
            {typing ? "Hide" : "Type"}
          </Button>
          <Button size="lg" onClick={() => setCamera(true)} icon={<Camera className="size-5" />}>
            Camera
          </Button>
          <Button size="lg" variant="primary" disabled={!value.trim() || busy} loading={busy} onClick={() => submit()}>
            OK
          </Button>
        </div>
      </form>
      {camera && (
        <CameraScanner
          onClose={() => setCamera(false)}
          onCode={(c) => {
            setCamera(false);
            onScan(c);
          }}
        />
      )}
    </div>
  );
}

interface DetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const Detector = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => DetectorLike }).BarcodeDetector;
    if (!Detector) {
      setError("Camera scanning isn't supported by this browser. Use the scanner trigger or type the code.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("The camera is only available over HTTPS. Use the scanner trigger or type the code.");
      return;
    }
    const detector = new Detector({ formats: ["code_128", "qr_code", "code_39", "ean_13", "data_matrix"] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then(async (s) => {
        stream = s;
        if (!video.current) return;
        video.current.srcObject = s;
        await video.current.play();
        const tick = async () => {
          if (stop || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0]?.rawValue) return onCode(codes[0].rawValue.trim());
          } catch {
            /* keep trying */
          }
          setTimeout(tick, 250);
        };
        void tick();
      })
      .catch(() => setError("Camera permission was refused. Use the scanner trigger or type the code."));
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between p-3 text-white">
        <span className="text-lg font-semibold">Point the camera at the barcode</span>
        <button onClick={onClose} className="rounded-full p-2 hover:bg-white/10" aria-label="Close camera">
          <X className="size-7" />
        </button>
      </div>
      {error ? (
        <div className="m-4 rounded-xl bg-surface p-4 text-base">{error}</div>
      ) : (
        <video ref={video} className="min-h-0 flex-1 object-cover" playsInline muted />
      )}
    </div>
  );
}
