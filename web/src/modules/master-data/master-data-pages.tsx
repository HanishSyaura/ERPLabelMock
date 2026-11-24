import { useSearchParams } from "react-router";
import { PageHeader, Tabs } from "@/components/common";
import { ReasonsTab } from "@/modules/planning/material-pages";
import type { ReasonCategory } from "@/modules/planning/ops-api";

const CATEGORIES: { id: ReasonCategory; label: string; hint: string }[] = [
  { id: "ADDITIONAL_ISSUE", label: "Additional issue", hint: "Why more material was issued than the MRS requested." },
  { id: "REJECT", label: "Material reject", hint: "Why issued material was rejected (damage, defects)." },
  { id: "SCRAP", label: "Scrap", hint: "Why material was scrapped during production." },
];

/** Master Data › Reason Code: one place for the reasons every material movement uses. */
export function ReasonCodePage() {
  const [params, setParams] = useSearchParams();
  const category = CATEGORIES.find((c) => c.id === params.get("category"))?.id ?? "ADDITIONAL_ISSUE";
  return (
    <>
      <PageHeader
        title="Reason Code"
        description="Reasons used by MRS Additional Issued, MRS Reject and Scrap Bad Material. Deactivate a reason instead of deleting it; past movements keep it."
        crumbs={[{ label: "Master Data" }, { label: "Reason Code" }]}
      />
      <Tabs tabs={CATEGORIES.map((c) => ({ id: c.id, label: c.label }))} value={category} onChange={(id) => setParams({ category: id })} />
      <p className="mb-3 text-sm text-muted">{CATEGORIES.find((c) => c.id === category)!.hint}</p>
      <ReasonsTab key={category} category={category} />
    </>
  );
}
