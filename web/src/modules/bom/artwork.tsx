import { AlertTriangle, Download, ExternalLink, FileImage, FileText, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { Button, Spinner } from "@/components/ui";
import { ApiError, uploadFile } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fileUrl, formatBytes, rev, thumbUrl, type DuplicateWarning, type FileInfo } from "./api";

export const ACCEPT = ".pdf,.ai,.eps,.svg,.png,.jpg,.jpeg";

/** Small square thumbnail; PDF / AI / EPS show a file-type tile. */
export function ArtworkThumb({ file, className }: { file: FileInfo | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  const box = cn("grid shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-surface-2", className ?? "size-14");
  if (file?.hasThumbnail && !broken) {
    return (
      <div className={box}>
        <img src={thumbUrl(file.id)} alt={`Artwork ${file.originalName}`} className="max-h-full max-w-full object-contain" loading="lazy" onError={() => setBroken(true)} />
      </div>
    );
  }
  return (
    <div className={cn(box, "flex-col gap-0.5 text-muted")} title={file?.originalName}>
      {file?.previewKind === "pdf" ? <FileText className="size-5" /> : <FileImage className="size-5" />}
      <span className="text-[10px] font-semibold uppercase">{file?.extension ?? "—"}</span>
    </div>
  );
}

/** Large preview: image, browser PDF viewer, or a download card for EPS / old AI. */
export function ArtworkPreview({ file, height = "h-80" }: { file: FileInfo; height?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className={cn("grid min-w-0 place-items-center overflow-hidden rounded-lg border border-line bg-surface-2", height)}>
        {file.previewKind === "image" ? (
          <img src={fileUrl(file.id)} alt={`Artwork ${file.originalName}`} className="max-h-full max-w-full object-contain" />
        ) : file.previewKind === "pdf" ? (
          <iframe src={`${fileUrl(file.id)}#toolbar=0&view=Fit`} title={`Artwork ${file.originalName}`} className="size-full bg-white" />
        ) : (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted">
            <FileImage className="size-10" />
            <p>
              No preview for {file.extension.toUpperCase()} files in the browser.
              <br />
              Download it to open in Illustrator or another design tool.
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="min-w-0 truncate font-medium text-text" title={file.originalName}>
          {file.originalName}
        </span>
        <span>· {formatBytes(file.sizeBytes)}</span>
        <span className="flex-1" />
        {file.previewKind !== "none" && (
          <a href={fileUrl(file.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            <ExternalLink className="size-3.5" /> Open
          </a>
        )}
        <a href={fileUrl(file.id, { download: true })} className="inline-flex items-center gap-1 text-primary hover:underline">
          <Download className="size-3.5" /> Download
        </a>
      </div>
    </div>
  );
}

export interface UploadResult {
  file: FileInfo;
  warnings: DuplicateWarning[];
}

/**
 * Drag-and-drop or browse. Uploads immediately so the user sees the preview
 * and duplicate warnings before saving; nothing is attached until Save.
 */
export function ArtworkDropzone({ value, onChange, error }: { value: UploadResult | null; onChange: (v: UploadResult | null) => void; error?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const start = async (file: File | undefined) => {
    if (!file) return;
    setUploadError(null);
    setProgress(0);
    try {
      onChange(await uploadFile<UploadResult>("/bom-files", file, setProgress));
    } catch (e) {
      setUploadError(e instanceof ApiError ? e.message : "Upload failed.");
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    void start(e.dataTransfer.files[0]);
  };

  if (value) {
    return (
      <div className="space-y-3">
        <div className="relative">
          <ArtworkPreview file={value.file} height="h-56" />
          <Button size="sm" variant="secondary" className="absolute top-2 right-2" icon={<X className="size-4" />} onClick={() => onChange(null)}>
            Change file
          </Button>
        </div>
        <DuplicateWarnings warnings={value.warnings} />
      </div>
    );
  }
  const message = uploadError ?? error;
  return (
    <div>
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        disabled={progress !== null}
        className={cn(
          "flex h-44 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 text-center transition-colors",
          drag ? "border-primary bg-primary-soft" : message ? "border-danger/60" : "border-line hover:border-primary hover:bg-surface-2",
        )}
      >
        {progress !== null ? (
          <>
            <Spinner />
            <span className="text-sm">Uploading… {Math.round(progress * 100)}%</span>
          </>
        ) : (
          <>
            <UploadCloud className="size-8 text-muted" />
            <span className="text-sm font-medium">Drop the artwork here, or click to browse</span>
            <span className="text-xs text-muted">PDF, AI, EPS, SVG, PNG or JPG</span>
          </>
        )}
      </button>
      <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void start(e.target.files?.[0])} />
      {message && <p className="mt-1.5 text-xs text-danger">{message}</p>}
    </div>
  );
}

export function DuplicateWarnings({ warnings }: { warnings: DuplicateWarning[] }) {
  if (!warnings.length) return null;
  return (
    <div role="status" className="space-y-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
      {warnings.map((w) => (
        <div key={w.type}>
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <AlertTriangle className="size-4 shrink-0" /> Possible duplicate: {w.message}
          </p>
          <ul className="mt-1 ml-6 list-disc space-y-0.5 text-text">
            {w.matches.slice(0, 5).map((m) => (
              <li key={m.bomId}>
                <Link to={`/bom/${m.bomId}`} target="_blank" className="font-medium text-primary hover:underline">
                  {m.fatherCode}
                </Link>{" "}
                – {m.labelDescription}
                {m.artworkRevision && !m.current ? <span className="text-muted"> (older artwork {rev(m.artworkRevision)})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-xs text-muted">This is a warning only. Save anyway if it's a different product.</p>
    </div>
  );
}
