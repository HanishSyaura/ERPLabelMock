import { ClipboardCheck, Factory, Flag, PackageCheck, PackagePlus, Sparkles, Truck, type LucideIcon } from "lucide-react";

/**
 * Guided flows (journeys), in production order. Shown on the Dashboard so
 * every start-to-end flow is one click away. `permission` = needed to start it.
 */
export interface GuidedFlow {
  id: string;
  stage: string;
  label: string;
  summary: string;
  steps: string[];
  path: string;
  permission: string;
  icon: LucideIcon;
}

export const GUIDED_FLOWS: GuidedFlow[] = [
  { id: "new-product", stage: "1 · Set up", label: "New product", summary: "Artwork to a released Master Card, ready for orders.", steps: ["Artwork", "Son Codes", "Part", "Master Card", "Release"], path: "/bom/new-product", permission: "bom.product.manage", icon: Sparkles },
  { id: "new-part", stage: "1 · Set up", label: "New part", summary: "A material, packaging or consumable in Part Master.", steps: ["Type", "General", "Technical", "Shipping & IQC"], path: "/master-data/part-master/new", permission: "bom.material.manage", icon: PackagePlus },
  { id: "iqc", stage: "2 · Material in", label: "Receive a lot (IQC)", summary: "Delivered lot to inspected, released material in its location.", steps: ["Lot", "Inspect", "Decide", "Store"], path: "/qc/iqc-check-in-out/receive", permission: "qc.iqc.inspect", icon: ClipboardCheck },
  { id: "new-pjo", stage: "3 · Order", label: "New Production Job Order", summary: "Order, Job Orders and MRS from the Master Card in one go.", steps: ["Product", "Order", "Job Orders", "Material", "Release"], path: "/planning/production-job-order/new", permission: "planning.pjo.create", icon: PackageCheck },
  { id: "issue", stage: "3 · Order", label: "Issue material", summary: "Hand the MRS material to production, line by line, by lot.", steps: ["MRS", "Qty & lot", "Done"], path: "/planning/material-requisition-sheet/issue", permission: "planning.mrs.issue", icon: Truck },
  { id: "handheld", stage: "4 · Produce", label: "Shopfloor (handheld)", summary: "Check In, output and Check Out per machine; material and QC tasks.", steps: ["Module", "Machine / task", "Record"], path: "/hh", permission: "shopfloor.handheld", icon: Factory },
  { id: "finish", stage: "5 · Finish", label: "Finish an order", summary: "Pick an order in progress, then Finish order: Job Orders → OQC → labels → close.", steps: ["Job Orders", "OQC", "Labels", "Close"], path: "/planning/production-job-order?stage=in_progress", permission: "planning.pjo.view", icon: Flag },
];
