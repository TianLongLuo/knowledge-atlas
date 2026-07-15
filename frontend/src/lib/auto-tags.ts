"use client";

import { getDocument, suggestDocumentTags, updateDocument } from "@/lib/api";
import { toast } from "sonner";

const activeJobs = new Map<string, Promise<string[]>>();
const recentAttempts = new Map<string, number>();
const ATTEMPT_COOLDOWN_MS = 60_000;

function normalizeTags(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, 12);
}

function canStart(documentId: string) {
  const now = Date.now();
  const lastAttempt = recentAttempts.get(documentId) || 0;
  if (now - lastAttempt < ATTEMPT_COOLDOWN_MS) return false;
  recentAttempts.set(documentId, now);
  return true;
}

/**
 * Generate and persist tags exactly once per document at a time.
 *
 * The read-after-write check catches stale full-draft saves and retries the
 * tag-only write once. Callers should flush their editor autosave before this
 * function so an older empty-tag draft cannot overwrite the result later.
 */
export function autoTagDocument(documentId: string, title: string, content: string): Promise<string[]> {
  const active = activeJobs.get(documentId);
  if (active) return active;
  if (!content.trim() || !canStart(documentId)) return Promise.resolve([]);

  const toastId = `atlas-auto-tags-${documentId}`;
  toast("No tags yet — Atlas is adding a few in the background.", { id: toastId, duration: 2200 });

  const job = (async () => {
    const response = await suggestDocumentTags({ title, content });
    const suggested = normalizeTags(response.tags);
    if (!suggested.length) {
      toast.dismiss(toastId);
      return [];
    }

    const serialized = suggested.join(", ");
    await updateDocument(documentId, { tags: serialized });
    let persisted = await getDocument(documentId);
    if (!persisted.tags.length) {
      await updateDocument(documentId, { tags: serialized });
      persisted = await getDocument(documentId);
    }
    if (!persisted.tags.length) throw new Error("Generated tags were not persisted");

    recentAttempts.delete(documentId);
    window.dispatchEvent(new CustomEvent("atlas:note-updated"));
    toast.success("Tags added", { id: toastId, duration: 1600 });
    return persisted.tags;
  })()
    .catch((cause) => {
      toast.error("Atlas could not add tags yet. Your note is still saved.", { id: toastId, duration: 2600 });
      throw cause;
    })
    .finally(() => activeJobs.delete(documentId));

  activeJobs.set(documentId, job);
  return job;
}
