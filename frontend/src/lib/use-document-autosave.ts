"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { updateDocument } from "@/lib/api";

export interface AutosaveDraft {
  title: string;
  content: string;
  tags: string;
  category?: string;
}

export type AutosaveState = "idle" | "local" | "saving" | "saved" | "warning" | "error";

interface Options {
  id: string | null;
  enabled: boolean;
  draft: AutosaveDraft;
  initialDraft: AutosaveDraft;
  storageKey: string;
  delay?: number;
  onSaved?: (draft: AutosaveDraft) => void;
}

interface StoredDraft extends AutosaveDraft {
  documentId?: string;
  savedAt: string;
}

const signature = (draft: AutosaveDraft) => JSON.stringify({
  title: draft.title.trim(),
  content: draft.content,
  tags: draft.tags,
  category: draft.category || "",
});

export function readStoredDraft(storageKey: string): StoredDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) as StoredDraft : null;
  } catch {
    return null;
  }
}

export function writeStoredDraft(storageKey: string, draft: AutosaveDraft, documentId?: string) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ ...draft, documentId, savedAt: new Date().toISOString() }));
  } catch {
    // Private browsing and storage quotas should not stop server autosave.
  }
}

export function clearStoredDraft(storageKey: string) {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Storage may be unavailable; the server copy is still authoritative.
  }
}

export function useDocumentAutosave({ id, enabled, draft, initialDraft, storageKey, delay = 850, onSaved }: Options) {
  const initialSignature = signature(initialDraft);
  const [state, setState] = useState<AutosaveState>("idle");
  const [message, setMessage] = useState("");
  const latestRef = useRef(draft);
  const savedSignatureRef = useRef(signature(initialDraft));
  const savingRef = useRef(false);
  const queuedRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  const idRef = useRef(id);
  const onSavedRef = useRef(onSaved);
  const runSaveRef = useRef<() => Promise<void>>(async () => undefined);
  const saveWaitersRef = useRef<Array<(saved: boolean) => void>>([]);

  useEffect(() => { latestRef.current = draft; }, [draft]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { idRef.current = id; }, [id]);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  const settleSaveWaiters = useCallback((saved: boolean) => {
    const waiters = saveWaitersRef.current.splice(0);
    waiters.forEach((resolve) => resolve(saved));
  }, []);

  useEffect(() => {
    savedSignatureRef.current = initialSignature;
    setState(enabled ? "saved" : "idle");
    setMessage("");
  }, [enabled, id, initialSignature]);

  const runSave = useCallback(async () => {
    if (!enabledRef.current || !idRef.current) {
      settleSaveWaiters(true);
      return;
    }
    if (savingRef.current) {
      queuedRef.current = true;
      return;
    }

    const snapshot = latestRef.current;
    const snapshotSignature = signature(snapshot);
    if (!snapshot.title.trim()) {
      setState("local");
      setMessage("Add a title to sync this draft");
      settleSaveWaiters(false);
      return;
    }
    if (snapshotSignature === savedSignatureRef.current) {
      setState("saved");
      setMessage("");
      clearStoredDraft(storageKey);
      settleSaveWaiters(true);
      return;
    }

    savingRef.current = true;
    queuedRef.current = false;
    let saved = true;
    setState("saving");
    setMessage("");
    try {
      const response = await updateDocument(idRef.current, snapshot);
      savedSignatureRef.current = snapshotSignature;
      onSavedRef.current?.(snapshot);
      if (signature(latestRef.current) === snapshotSignature) {
        clearStoredDraft(storageKey);
        if (response.metadata?.notion_sync_status === "failed") {
          setState("warning");
          setMessage("Saved in Atlas · Notion will retry automatically");
        } else {
          setState("saved");
          setMessage("");
        }
      } else {
        queuedRef.current = true;
      }
    } catch (cause) {
      saved = false;
      setState("error");
      setMessage(cause instanceof Error ? cause.message : "Server unavailable; your draft is safe locally");
      if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => void runSaveRef.current(), 4000);
    } finally {
      savingRef.current = false;
      if (queuedRef.current && enabledRef.current) {
        queuedRef.current = false;
        window.setTimeout(() => void runSaveRef.current(), 0);
      } else {
        settleSaveWaiters(saved);
      }
    }
  }, [settleSaveWaiters, storageKey]);

  useEffect(() => { runSaveRef.current = runSave; }, [runSave]);

  useEffect(() => {
    if (!enabled) return;
    const currentSignature = signature(draft);
    if (currentSignature === savedSignatureRef.current) return;
    writeStoredDraft(storageKey, draft, id || undefined);
    setState("local");
    setMessage(id ? "Waiting to sync" : "Saved on this device");
    const timer = window.setTimeout(() => void runSave(), delay);
    return () => window.clearTimeout(timer);
  }, [delay, draft, enabled, id, runSave, storageKey]);

  useEffect(() => () => {
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    settleSaveWaiters(false);
  }, [settleSaveWaiters]);

  const saveNow = useCallback(() => new Promise<boolean>((resolve) => {
    saveWaitersRef.current.push(resolve);
    void runSaveRef.current();
  }), []);

  return { state, message, saveNow };
}
