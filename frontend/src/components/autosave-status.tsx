"use client";

import { Check, Cloud, CloudOff, Loader2, TriangleAlert } from "lucide-react";
import type { AutosaveState } from "@/lib/use-document-autosave";

export function AutosaveStatus({ state, message }: { state: AutosaveState; message?: string }) {
  const content = {
    idle: { icon: Cloud, label: "Autosave ready", className: "text-slate-400" },
    local: { icon: Cloud, label: message || "Draft saved locally", className: "text-amber-600" },
    saving: { icon: Loader2, label: "Saving…", className: "text-blue-600" },
    saved: { icon: Check, label: "Saved", className: "text-emerald-600" },
    warning: { icon: TriangleAlert, label: message || "Saved · Notion sync pending", className: "text-amber-600" },
    error: { icon: CloudOff, label: message || "Saved locally · retrying", className: "text-red-600" },
  }[state];
  const Icon = content.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${content.className}`} title={message || content.label}>
      <Icon className={`h-3.5 w-3.5 ${state === "saving" ? "animate-spin" : ""}`} />
      <span>{content.label}</span>
    </span>
  );
}
