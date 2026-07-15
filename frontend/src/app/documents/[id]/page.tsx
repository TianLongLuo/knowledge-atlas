"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getDocument, updateDocument, deleteDocument, suggestDocumentTags,
  DocumentDetail,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AIWritingAssistant } from "@/components/ai-writing-assistant";
import { AutosaveStatus } from "@/components/autosave-status";
import { MarkdownEditor } from "@/components/markdown-editor";
import { MarkdownContent } from "@/components/markdown-content";
import { readStoredDraft, useDocumentAutosave } from "@/lib/use-document-autosave";
import { ArrowLeft, Check, Pencil, Trash2, Loader2, Tag } from "lucide-react";
import { toast } from "sonner";

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadDoc = async () => {
    setLoading(true);
    try {
      const doc = await getDocument(id);
      setDocument(doc);
      setEditTitle(doc.title);
      setEditContent(doc.content || "");
      setEditTags(doc.tags.join(", "));
      if (new URLSearchParams(window.location.search).get("edit") === "1") {
        const stored = readStoredDraft(`atlas:document-draft:${id}`);
        if (stored) {
          setEditTitle(stored.title);
          setEditContent(stored.content);
          setEditTags(stored.tags);
        }
        setEditing(true);
      }
    } catch (err) {
      console.error("Failed to load:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDoc(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTagsInBackground = () => {
    if (editTags.split(/[,，]/).some((tag) => tag.trim()) || !editContent.trim()) return;
    toast("No tags yet — Atlas is adding a few in the background.", { duration: 2200 });
    void suggestDocumentTags({ title: editTitle, content: editContent })
      .then(async ({ tags }) => { if (tags.length) await updateDocument(id, { tags: tags.join(", ") }); })
      .catch(() => undefined);
  };

  const draft = useMemo(() => ({ title: editTitle, content: editContent, tags: editTags }), [editContent, editTags, editTitle]);
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
    id,
    enabled: editing && Boolean(document),
    draft,
    initialDraft,
    storageKey: `atlas:document-draft:${id}`,
    onSaved: handleAutosaved,
  });

  const beginEditing = () => {
    const stored = readStoredDraft(`atlas:document-draft:${id}`);
    if (stored) {
      setEditTitle(stored.title);
      setEditContent(stored.content);
      setEditTags(stored.tags);
      toast("Recovered your unsaved local draft.", { duration: 1800 });
    }
    setEditing(true);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteDocument(id);
      router.push("/documents");
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 max-w-5xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!document) {
    return (
      <div className="max-w-5xl mx-auto text-center py-12">
        <p className="text-muted-foreground">Document not found</p>
        <Button variant="outline" onClick={() => router.push("/documents")} className="mt-4">
          <ArrowLeft className="mr-2 h-4 w-4" />Back to documents
        </Button>
      </div>
    );
  }

  const sourceLabel = (t: string) => {
    const labels: Record<string, string> = { file: "File", url: "URL", manual: "Manual", api: "API", chromadb: "ChromaDB", web: "Web" };
    return labels[t] || t;
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-5.5rem)] min-h-[680px] max-w-[1320px] flex-col overflow-hidden rounded-[20px] border border-white/85 bg-white/86 shadow-[0_22px_80px_rgba(71,85,105,.10)] backdrop-blur-sm">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 px-3 sm:px-4">
        <Button variant="ghost" size="sm" onClick={() => { if (editing) void autosave.saveNow(); addTagsInBackground(); router.push("/documents"); }} className="h-8 text-slate-500">
          <ArrowLeft className="mr-1.5 h-4 w-4" />Documents
        </Button>
        <div className="flex items-center gap-1.5">
          {editing ? (
            <>
              <AutosaveStatus state={autosave.state} message={autosave.message} />
              <Button variant="ghost" size="sm" className="h-8" onClick={() => { void autosave.saveNow(); addTagsInBackground(); setEditing(false); }}>
                <Check className="h-4 w-4 mr-1" />Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="h-8" onClick={beginEditing}>
                <Pencil className="h-4 w-4 mr-1" />Edit
              </Button>
              {confirmDelete ? (
                <div className="flex items-center gap-1">
                  <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
                    {deleting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}Confirm delete
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                </div>
              ) : (
                <Button variant="ghost" size="icon-sm"
                  className="text-slate-400 hover:text-red-600"
                  onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-4 w-4" /><span className="sr-only">Delete</span>
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      {editing ? (
        <div className="relative mx-auto min-h-0 w-full max-w-[1200px] flex-1 overflow-hidden px-4 sm:px-7">
          <article className="mx-auto flex h-full min-h-0 w-full max-w-[900px] flex-col">
            <div className="shrink-0 px-5 pb-3 pt-10 sm:px-10">
              <Input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} placeholder="Untitled" className="h-auto rounded-none border-0 bg-transparent px-0 py-1 font-heading text-4xl font-semibold tracking-tight text-slate-900 shadow-none focus-visible:ring-0 md:text-4xl" />
              <div className="mt-4 flex items-center gap-2">
                <div className="relative min-w-0 flex-1"><Tag className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><Input value={editTags} onChange={(event) => setEditTags(event.target.value)} placeholder="Add tags" className="h-8 border-0 bg-slate-50 pl-8 shadow-none hover:bg-slate-100 focus-visible:ring-1" /></div>
                <span className="text-xs tabular-nums text-slate-400">{editContent.length.toLocaleString()} characters</span>
              </div>
            </div>
            <MarkdownEditor value={editContent} onChange={setEditContent} placeholder="Start writing…" className="min-h-0 flex-1" />
          </article>
          <div className="pointer-events-none absolute inset-y-5 right-0 z-10 flex min-h-0 items-start">
            <AIWritingAssistant title={editTitle} content={editContent} documentId={Number(id)} onApplyTitle={setEditTitle} />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <article className="mx-auto max-w-4xl px-8 pb-20 pt-14 sm:px-14">
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-slate-900">{document.title}</h1>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-400"><Badge variant="outline">{sourceLabel(document.source_type)}</Badge>{document.tags.map((tag) => <Badge key={tag} variant="secondary">#{tag}</Badge>)}<span>Updated {new Date(document.updated_at || document.created_at).toLocaleString()}</span></div>
            <MarkdownContent className="mt-10">{document.content || "No content"}</MarkdownContent>
          </article>
        </div>
      )}
    </div>
  );
}
