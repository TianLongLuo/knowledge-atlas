"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteDocument, getDocument } from "@/lib/api";
import type { DocumentDetail } from "@/lib/api";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MarkdownContent } from "@/components/markdown-content";
import { AIWritingAssistant } from "@/components/ai-writing-assistant";
import { AutosaveStatus } from "@/components/autosave-status";
import { MarkdownEditor } from "@/components/markdown-editor";
import { readStoredDraft, useDocumentAutosave } from "@/lib/use-document-autosave";
import { autoTagDocument } from "@/lib/auto-tags";
import { Bot, Check, Loader2, Maximize2, Pencil, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";

interface NoteReaderContextValue {
  openDocument: (id: string | number) => void;
  closeDocument: () => void;
}

const NoteReaderContext = createContext<NoteReaderContextValue | null>(null);

export function useNoteReader() {
  const value = useContext(NoteReaderContext);
  if (!value) throw new Error("useNoteReader must be used inside NoteReaderProvider");
  return value;
}

export function NoteReaderProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const closeImmediately = useCallback(() => {
    setDocumentId(null);
    setDocument(null);
    setEditing(false);
    setConfirmDelete(false);
    setError("");
  }, []);

  const openDocument = useCallback((id: string | number) => {
    setDocumentId(String(id));
    setEditing(false);
    setConfirmDelete(false);
  }, []);

  const loadDocument = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await getDocument(id);
      setDocument(next);
      setTitle(next.title);
      setContent(next.content || "");
      setTags(next.tags.join(", "));
    } catch (cause) {
      setDocument(null);
      setError(cause instanceof Error ? cause.message : "Unable to load this note.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (documentId) void loadDocument(documentId);
  }, [documentId, loadDocument]);

  const draft = useMemo(() => ({ title, content, tags }), [content, tags, title]);
  const initialDraft = useMemo(() => ({
    title: document?.title || "",
    content: document?.content || "",
    tags: document?.tags.join(", ") || "",
  }), [document]);
  const handleAutosaved = useCallback((next: { title: string; content: string; tags: string }) => {
    setDocument((current) => current ? {
      ...current,
      title: next.title.trim(),
      content: next.content,
      tags: next.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      updated_at: new Date().toISOString(),
    } : current);
    window.dispatchEvent(new CustomEvent("atlas:note-updated"));
  }, []);
  const autosave = useDocumentAutosave({
    id: documentId,
    enabled: editing && Boolean(document),
    draft,
    initialDraft,
    storageKey: `atlas:document-draft:${documentId || "none"}`,
    onSaved: handleAutosaved,
  });

  const closeDocument = useCallback(() => {
    const savePromise = editing ? autosave.saveNow() : Promise.resolve(true);
    const snapshot = documentId && document && !tags.split(/[,，]/).some((tag) => tag.trim())
      ? { id: documentId, title: editing ? title : document.title, content: editing ? content : document.content }
      : null;
    closeImmediately();
    if (!snapshot || !snapshot.content.trim()) return;
    void savePromise.then((saved) => saved
      ? autoTagDocument(snapshot.id, snapshot.title, snapshot.content)
      : undefined
    ).catch(() => undefined);
  }, [autosave, closeImmediately, content, document, documentId, editing, tags, title]);

  const finishEditing = useCallback(() => {
    const snapshot = documentId && !tags.split(/[,，]/).some((tag) => tag.trim())
      ? { id: documentId, title, content }
      : null;
    const savePromise = autosave.saveNow();
    setEditing(false);
    if (!snapshot || !snapshot.content.trim()) return;
    void savePromise.then(async (saved) => {
      if (!saved) return;
      const suggested = await autoTagDocument(snapshot.id, snapshot.title, snapshot.content);
      if (!suggested.length) return;
      setTags(suggested.join(", "));
      setDocument((current) => current ? { ...current, tags: suggested } : current);
    }).catch(() => undefined);
  }, [autosave, content, documentId, tags, title]);

  const beginEditing = () => {
    if (!documentId || !document) return;
    const stored = readStoredDraft(`atlas:document-draft:${documentId}`);
    if (stored) {
      setTitle(stored.title);
      setContent(stored.content);
      setTags(stored.tags);
      toast("Recovered your unsaved local draft.", { duration: 1800 });
    }
    setEditing(true);
  };

  const remove = async () => {
    if (!documentId) return;
    setDeleting(true);
    setError("");
    try {
      await deleteDocument(documentId);
      closeImmediately();
      window.dispatchEvent(new CustomEvent("atlas:note-deleted"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to delete this note.");
    } finally {
      setDeleting(false);
    }
  };

  const value = useMemo(() => ({ openDocument, closeDocument }), [openDocument, closeDocument]);

  return (
    <NoteReaderContext.Provider value={value}>
      {children}
      <Dialog open={Boolean(documentId)} onOpenChange={(open) => { if (!open) closeDocument(); }}>
        <DialogContent showCloseButton={false} overlayClassName="bg-slate-950/45 backdrop-blur-[2px]" className="flex h-[min(92vh,960px)] max-h-[92vh] flex-col gap-0 overflow-hidden rounded-[18px] border-white/80 bg-white p-0 shadow-[0_36px_120px_rgba(15,23,42,.34)] sm:max-w-[min(88vw,1320px)]">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 px-4">
            <DialogTitle className="max-w-[40vw] truncate text-sm font-medium text-slate-500">{document?.title || "Note"}</DialogTitle>
            <div className="flex items-center gap-1.5">
              {editing && <AutosaveStatus state={autosave.state} message={autosave.message} />}
              {document && !editing && <Button variant="ghost" size="sm" className="h-8" onClick={() => { closeDocument(); router.push(`/agent?doc=${document.id}`); }}><Bot className="mr-1.5 h-4 w-4" />Ask AI</Button>}
              {document && <Button variant="ghost" size="icon-sm" onClick={() => { closeDocument(); router.push(`/documents/${document.id}?edit=1`); }} aria-label="Open as full page" title="Open as full page"><Maximize2 className="h-4 w-4" /></Button>}
              {document && (editing ? <Button variant="ghost" size="sm" className="h-8" onClick={finishEditing}><Check className="mr-1.5 h-4 w-4" />Done</Button> : <Button variant="ghost" size="sm" className="h-8" onClick={beginEditing}><Pencil className="mr-1.5 h-4 w-4" />Edit</Button>)}
              <Button type="button" variant="ghost" size="icon-sm" onClick={closeDocument} aria-label="Close note"><X className="h-4 w-4" /></Button>
            </div>
          </header>

          <div className={`min-h-0 flex-1 overscroll-contain ${editing ? "overflow-hidden px-4 sm:px-7" : "overflow-y-auto"}`}>
            {loading && <div className="grid min-h-[45vh] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>}
            {error && !document && <p className="m-8 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            {!loading && document && (editing ? (
              <div className="relative mx-auto h-full min-h-0 w-full max-w-[1200px]">
                <article className="mx-auto flex h-full min-h-0 w-full max-w-[900px] flex-col">
                  <div className="shrink-0 px-5 pb-3 pt-10 sm:px-10">
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Untitled" className="h-auto rounded-none border-0 bg-transparent px-0 py-1 font-heading text-4xl font-semibold tracking-tight text-slate-900 shadow-none focus-visible:ring-0 md:text-4xl" />
                    <div className="relative mt-4"><Tag className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="Add tags" className="h-8 border-0 bg-slate-50 pl-8 shadow-none hover:bg-slate-100 focus-visible:ring-1" /></div>
                  </div>
                  <MarkdownEditor value={content} onChange={setContent} className="min-h-0 flex-1" />
                </article>
                <div className="pointer-events-none absolute inset-y-5 right-0 z-10 flex min-h-0 items-start">
                  <AIWritingAssistant title={title} content={content} documentId={Number(documentId)} onApplyTitle={setTitle} />
                </div>
              </div>
            ) : (
              <article className="mx-auto max-w-4xl px-8 pb-20 pt-14 sm:px-14">
                <h1 className="font-heading text-4xl font-semibold tracking-tight text-slate-900">{document.title}</h1>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400"><Badge variant="outline">{document.source_type}</Badge>{document.tags.map((tag) => <Badge key={tag} variant="secondary">#{tag}</Badge>)}<span>Updated {new Date(document.updated_at).toLocaleString()}</span></div>
                <MarkdownContent className="mt-10">{document.content || "This note has no readable content."}</MarkdownContent>
              </article>
            ))}
          </div>
          {document && !editing && <div className="absolute bottom-4 right-5 flex items-center gap-1 rounded-xl border border-slate-200/80 bg-white/90 p-1 shadow-sm backdrop-blur">
            {confirmDelete ? <><Button size="sm" variant="destructive" onClick={() => void remove()} disabled={deleting}>{deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Confirm delete</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button></> : <Button size="icon-sm" variant="ghost" className="text-slate-400 hover:text-red-600" onClick={() => setConfirmDelete(true)} title="Delete note"><Trash2 className="h-4 w-4" /></Button>}
          </div>}
        </DialogContent>
      </Dialog>
    </NoteReaderContext.Provider>
  );
}
