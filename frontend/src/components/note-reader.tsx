"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteDocument, getDocument, updateDocument } from "@/lib/api";
import type { DocumentDetail } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { MarkdownContent } from "@/components/markdown-content";
import { Bot, Loader2, Pencil, Save, Trash2, X } from "lucide-react";

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
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const closeDocument = useCallback(() => {
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

  const save = async () => {
    if (!documentId || !title.trim()) return;
    setSaving(true);
    try {
      await updateDocument(documentId, { title: title.trim(), content });
      await loadDocument(documentId);
      setEditing(false);
      window.dispatchEvent(new CustomEvent("atlas:note-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save this note.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!documentId) return;
    setDeleting(true);
    try {
      await deleteDocument(documentId);
      closeDocument();
      window.dispatchEvent(new CustomEvent("atlas:note-deleted"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete this note.");
    } finally {
      setDeleting(false);
    }
  };

  const value = useMemo(() => ({ openDocument, closeDocument }), [openDocument, closeDocument]);

  return (
    <NoteReaderContext.Provider value={value}>
      {children}
      <Dialog open={Boolean(documentId)} onOpenChange={(open) => { if (!open) closeDocument(); }}>
        <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden border-white/90 bg-white/95 p-0 shadow-[0_30px_100px_rgba(56,76,120,0.25)] backdrop-blur-xl sm:max-w-5xl">
          <div className="border-b bg-[linear-gradient(120deg,rgba(219,238,255,.75),rgba(255,239,220,.58),rgba(255,225,239,.55))] px-7 py-5">
            <DialogHeader>
              {editing ? (
                <Input value={title} onChange={(event) => setTitle(event.target.value)} className="mr-12 bg-white/75 text-xl font-semibold" />
              ) : <DialogTitle className="pr-12 text-xl leading-snug">{document?.title || "Note"}</DialogTitle>}
              <DialogDescription className="flex items-center gap-2">
                {document && <><Badge variant="outline" className="bg-white/60">{document.source_type}</Badge><span>Updated {new Date(document.updated_at).toLocaleString()}</span></>}
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 py-6 sm:px-10" style={{ height: "min(68vh, 760px)" }}>
            {loading && <div className="grid min-h-[45vh] place-items-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>}
            {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            {!loading && document && (editing ? (
              <Textarea value={content} onChange={(event) => setContent(event.target.value)} className="min-h-[55vh] resize-y bg-white text-sm leading-7" />
            ) : (
              <MarkdownContent>{document.content || "This note has no readable content."}</MarkdownContent>
            ))}
          </div>

          {document && <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-slate-50/75 px-7 py-4">
            <Button variant="outline" onClick={() => { closeDocument(); router.push(`/agent?doc=${document.id}`); }}>
              <Bot className="mr-2 h-4 w-4" />Ask AI about this note
            </Button>
            <div className="flex items-center gap-2">
              {editing ? <>
                <Button onClick={() => void save()} disabled={saving || !title.trim()}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save</Button>
                <Button variant="ghost" onClick={() => { setEditing(false); setTitle(document.title); setContent(document.content); }}><X className="mr-2 h-4 w-4" />Cancel</Button>
              </> : <>
                <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="mr-2 h-4 w-4" />Edit</Button>
                {confirmDelete ? <>
                  <Button variant="destructive" onClick={() => void remove()} disabled={deleting}>{deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm delete</Button>
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                </> : <Button variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => setConfirmDelete(true)}><Trash2 className="mr-2 h-4 w-4" />Delete</Button>}
              </>}
            </div>
          </div>}
        </DialogContent>
      </Dialog>
    </NoteReaderContext.Provider>
  );
}
