"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Check, Maximize2, Plus, Tag, X } from "lucide-react";
import { createNote, getDocumentFilterOptions } from "@/lib/api";
import { AIWritingAssistant } from "@/components/ai-writing-assistant";
import { AutosaveStatus } from "@/components/autosave-status";
import { MarkdownEditor } from "@/components/markdown-editor";
import { AutosaveDraft, AutosaveState, clearStoredDraft, readStoredDraft, useDocumentAutosave, writeStoredDraft } from "@/lib/use-document-autosave";

interface Props {
  onCreated?: () => void;
}

const NEW_NOTE_DRAFT_KEY = "atlas:new-note-draft";
const EMPTY_DRAFT: AutosaveDraft = { title: "", content: "", tags: "", category: "" };

export function CreateNoteDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [createdBaseline, setCreatedBaseline] = useState<AutosaveDraft>(EMPTY_DRAFT);
  const [createState, setCreateState] = useState<AutosaveState>("idle");
  const [createMessage, setCreateMessage] = useState("");
  const creatingRef = useRef(false);
  const router = useRouter();

  useEffect(() => {
    void getDocumentFilterOptions().then((data) => setCategories(data.categories.map((item) => item.name))).catch(() => undefined);
  }, []);

  const draft = useMemo(() => ({ title, content, tags, category }), [category, content, tags, title]);

  const ensureCreated = useCallback(async () => {
    if (documentId || creatingRef.current || !title.trim() || !content.trim()) return;
    const snapshot = { title: title.trim(), content, tags: tags.trim(), category };
    creatingRef.current = true;
    setCreateState("saving");
    setCreateMessage("");
    writeStoredDraft(NEW_NOTE_DRAFT_KEY, snapshot);
    try {
      const created = await createNote({ ...snapshot, source: "manual" });
      const nextId = String(created.id);
      setDocumentId(nextId);
      setCreatedBaseline(snapshot);
      writeStoredDraft(NEW_NOTE_DRAFT_KEY, snapshot, nextId);
      if (created.notion_sync?.status === "failed") {
        setCreateState("warning");
        setCreateMessage("Saved in Atlas · Notion will retry automatically");
      } else {
        setCreateState("saved");
        setCreateMessage("");
      }
      router.refresh();
      onCreated?.();
      window.dispatchEvent(new CustomEvent("atlas:note-created", { detail: { id: nextId } }));
      window.dispatchEvent(new CustomEvent("atlas:note-updated"));
    } catch (cause) {
      setCreateState("error");
      setCreateMessage(cause instanceof Error ? cause.message : "Server unavailable; your draft is safe locally");
    } finally {
      creatingRef.current = false;
    }
  }, [category, content, documentId, onCreated, router, tags, title]);

  const autosave = useDocumentAutosave({
    id: documentId,
    enabled: open && Boolean(documentId),
    draft,
    initialDraft: createdBaseline,
    storageKey: NEW_NOTE_DRAFT_KEY,
    onSaved: () => {
      setCreateState("saved");
      window.dispatchEvent(new CustomEvent("atlas:note-updated"));
    },
  });

  useEffect(() => {
    if (!open || documentId) return;
    writeStoredDraft(NEW_NOTE_DRAFT_KEY, draft);
    setCreateState("local");
    setCreateMessage(title.trim() && content.trim() ? "Waiting to sync" : "Draft saved on this device");
    if (!title.trim() || !content.trim()) return;
    const timer = window.setTimeout(() => void ensureCreated(), 850);
    return () => window.clearTimeout(timer);
  }, [content, documentId, draft, ensureCreated, open, title]);

  useEffect(() => {
    if (open || !documentId || !["saved", "warning"].includes(createState)) return;
    clearStoredDraft(NEW_NOTE_DRAFT_KEY);
    setTitle("");
    setContent("");
    setTags("");
    setCategory("");
    setDocumentId(null);
    setCreatedBaseline(EMPTY_DRAFT);
    setCreateState("idle");
  }, [createState, documentId, open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const stored = readStoredDraft(NEW_NOTE_DRAFT_KEY);
      if (stored) {
        setTitle(stored.title);
        setContent(stored.content);
        setTags(stored.tags);
        setCategory(stored.category || "");
        setDocumentId(stored.documentId || null);
        setCreatedBaseline(EMPTY_DRAFT);
        setCreateState("local");
        setCreateMessage("Recovered your previous draft");
      }
      setOpen(true);
      return;
    }

    if (documentId) void autosave.saveNow();
    else if (title.trim() && content.trim()) void ensureCreated();
    setOpen(false);
    if (documentId && ["saved", "warning"].includes(autosave.state)) {
      clearStoredDraft(NEW_NOTE_DRAFT_KEY);
      setTitle("");
      setContent("");
      setTags("");
      setCategory("");
      setDocumentId(null);
      setCreatedBaseline(EMPTY_DRAFT);
      setCreateState("idle");
    }
  };

  const openAsPage = () => {
    if (!documentId) return;
    void autosave.saveNow();
    setOpen(false);
    router.push(`/documents/${documentId}?edit=1`);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button className="gap-2" />}>
        <Plus className="h-4 w-4" />
        New note
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-slate-950/45 backdrop-blur-[2px]"
        className="flex h-[min(92vh,960px)] max-h-[92vh] flex-col gap-0 overflow-hidden rounded-[18px] border-white/80 bg-white p-0 text-foreground shadow-[0_36px_120px_rgba(15,23,42,.34)] sm:max-w-[min(88vw,1320px)]"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 px-4">
          <DialogTitle className="text-sm font-medium text-slate-500">New note</DialogTitle>
          <div className="flex items-center gap-1.5">
            <AutosaveStatus state={documentId ? autosave.state : createState} message={documentId ? autosave.message : createMessage} />
            <Button type="button" variant="ghost" size="icon-sm" onClick={openAsPage} disabled={!documentId} aria-label="Open as full page" title={documentId ? "Open as full page" : "Start writing to create the page first"}>
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)} className="h-8 px-2.5 text-slate-600">
              <Check className="mr-1.5 h-4 w-4" />Done
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => handleOpenChange(false)} aria-label="Close note">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-4 sm:px-7">
          <div className="relative mx-auto h-full min-h-0 w-full max-w-[1200px]">
            <article className="mx-auto flex h-full min-h-0 w-full max-w-[900px] flex-col">
              <div className="shrink-0 px-5 pb-3 pt-10 sm:px-10">
                <Input
                  placeholder="Untitled"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="h-auto rounded-none border-0 bg-transparent px-0 py-1 font-heading text-4xl font-semibold tracking-tight text-slate-900 shadow-none placeholder:text-slate-300 focus-visible:ring-0 md:text-4xl"
                />
                <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <Select value={category} onValueChange={(value) => setCategory(value || "")}>
                    <SelectTrigger className="h-8 w-auto min-w-40 border-0 bg-slate-50 px-2.5 shadow-none hover:bg-slate-100"><SelectValue placeholder="Add category" /></SelectTrigger>
                    <SelectContent>{categories.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                  </Select>
                  <div className="relative min-w-60 flex-1">
                    <Tag className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <Input placeholder="Add tags" value={tags} onChange={(event) => setTags(event.target.value)} className="h-8 border-0 bg-slate-50 pl-8 shadow-none hover:bg-slate-100 focus-visible:ring-1" />
                  </div>
                  <span className="ml-auto text-xs tabular-nums text-slate-400">{content.length.toLocaleString()} characters</span>
                </div>
              </div>
              <MarkdownEditor value={content} onChange={setContent} className="min-h-0 flex-1" ariaLabel="Note content" />
            </article>
            <div className="pointer-events-none absolute inset-y-5 right-0 z-10 flex min-h-0 items-start">
              <AIWritingAssistant title={title} content={content} onApplyTitle={setTitle} />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
