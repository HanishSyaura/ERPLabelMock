import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const dateTime = new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dateOnly = new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "short", year: "numeric" });

export const formatDateTime = (v: string | Date | null | undefined) => (v ? dateTime.format(new Date(v)) : "—");
export const formatDate = (v: string | Date | null | undefined) => (v ? dateOnly.format(new Date(v)) : "—");

/** "USER_CREATED" -> "User created" */
export const humanize = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");
