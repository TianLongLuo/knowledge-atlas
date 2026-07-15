"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getDocuments, getDocumentFilterOptions, deleteDocument, updateDocument, DocumentItem } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText, Search, ArrowRight, Calendar, Trash2, Loader2, ArrowDownUp, Tag,
} from "lucide-react";
import { CreateNoteDialog } from "@/components/create-note-dialog";
import { useNoteReader } from "@/components/note-reader";
import { toast } from "sonner";

const sourceTypes = [
  { value: "all", label: "All types" },
  { value: "file", label: "File" },
  { value: "url", label: "URL" },
  { value: "manual", label: "Manual" },
  { value: "api", label: "API" },
];

function clientFilterDocuments(items: DocumentItem[], filters: {
  search: string; sourceType: string; dateFrom: string; dateTo: string; dateField: "note_date" | "system_created";
  category: string; tag: string; sortBy: "note_date" | "system_created" | "updated_at" | "title"; sortOrder: "asc" | "desc";
}) {
  const needle = filters.search.trim().toLocaleLowerCase();
  const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : null;
  const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : null;
  const filtered = items.filter((item) => {
    if (filters.sourceType !== "all" && item.source_type !== filters.sourceType) return false;
    if (filters.category !== "all" && (item.category || "").toLocaleLowerCase() !== filters.category.toLocaleLowerCase()) return false;
    if (filters.tag !== "all" && !(item.tags || []).some((value) => value.toLocaleLowerCase() === filters.tag.toLocaleLowerCase())) return false;
    if (needle && ![item.title || "", item.content || "", item.category || "", (item.tags || []).join(" ")].join("\n").toLocaleLowerCase().includes(needle)) return false;
    const dateValue = new Date(filters.dateField === "note_date" ? item.note_at : item.created_at).getTime();
    if (from !== null && (!Number.isFinite(dateValue) || dateValue < from)) return false;
    if (to !== null && (!Number.isFinite(dateValue) || dateValue > to)) return false;
    return true;
  });
  const direction = filters.sortOrder === "asc" ? 1 : -1;
  filtered.sort((left, right) => {
    if (filters.sortBy === "title") return left.title.localeCompare(right.title) * direction;
    const leftDate = new Date(filters.sortBy === "note_date" ? left.note_at : filters.sortBy === "system_created" ? left.created_at : left.updated_at).getTime() || 0;
    const rightDate = new Date(filters.sortBy === "note_date" ? right.note_at : filters.sortBy === "system_created" ? right.created_at : right.updated_at).getTime() || 0;
    return (leftDate - rightDate) * direction;
  });
  return filtered;
}

async function loadCompatibilityDocumentSet() {
  const first = await getDocuments({ page: 1, page_size: 100 });
  const items = [...first.items];
  const pages = Math.ceil(first.total / 100);
  for (let page = 2; page <= pages; page += 1) {
    const next = await getDocuments({ page, page_size: 100 });
    items.push(...next.items);
  }
  return items;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateField, setDateField] = useState<"note_date" | "system_created">("note_date");
  const [category, setCategory] = useState("all");
  const [tag, setTag] = useState("all");
  const [categoryOptions, setCategoryOptions] = useState<Array<{ name: string; tags: string[] }>>([]);
  const [sortBy, setSortBy] = useState<"note_date" | "system_created" | "updated_at" | "title">("note_date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingTags, setEditingTags] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [tagSaveState, setTagSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const tagSaveVersionRef = useRef(0);
  const { openDocument } = useNoteReader();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRequestedRef = useRef(false);
  const queryVersionRef = useRef(0);
  const pageSize = 20;

  const saveInlineTags = useCallback(async (documentId: string, close = false) => {
    const normalized = tagDraft.split(/[,，]/).map((value) => value.trim()).filter(Boolean).join(", ");
    const version = ++tagSaveVersionRef.current;
    setTagSaveState("saving");
    try {
      await updateDocument(documentId, { tags: normalized });
      if (version !== tagSaveVersionRef.current) return;
      setDocuments((current) => current.map((item) => item.id === documentId
        ? { ...item, tags: normalized ? normalized.split(", ") : [] }
        : item));
      setTagSaveState("saved");
      if (close) setEditingTags(null);
    } catch (error) {
      if (version !== tagSaveVersionRef.current) return;
      setTagSaveState("error");
      toast.error(error instanceof Error ? error.message : "Unable to update tags");
    }
  }, [tagDraft]);

  useEffect(() => {
    if (!editingTags) return;
    setTagSaveState("idle");
    const timer = window.setTimeout(() => void saveInlineTags(editingTags), 850);
    return () => window.clearTimeout(timer);
  }, [editingTags, saveInlineTags]);

  const loadDocuments = useCallback(async (pageToLoad: number, replace: boolean, requestVersion = queryVersionRef.current) => {
    if (replace) setLoading(true); else setLoadingMore(true);
    setLoadError("");
    try {
      const params: Record<string, string | number> = { page: pageToLoad, page_size: pageSize };
      if (search.trim()) params.search = search.trim();
      if (sourceType !== "all") params.source_type = sourceType;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      if (dateFrom || dateTo) params.date_field = dateField;
      if (category !== "all") params.category = category;
      if (tag !== "all") params.tag = tag;
      if (sortBy !== "note_date") params.sort_by = sortBy;
      if (sortOrder !== "desc") params.sort_order = sortOrder;
      let data = await getDocuments(params as Parameters<typeof getDocuments>[0]);
      if (data.total === 0) {
        const allItems = await loadCompatibilityDocumentSet();
        if (allItems.length) {
          const compatible = clientFilterDocuments(allItems, { search, sourceType, dateFrom, dateTo, dateField, category, tag, sortBy, sortOrder });
          const start = (pageToLoad - 1) * pageSize;
          data = { items: compatible.slice(start, start + pageSize), total: compatible.length, page: pageToLoad, page_size: pageSize };
        }
      }
      if (requestVersion !== queryVersionRef.current) return;
      setDocuments((current) => {
        if (replace) return data.items;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...data.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(data.total);
    } catch (err) {
      console.error("Failed to load documents:", err);
      if (requestVersion === queryVersionRef.current) setLoadError(err instanceof Error ? err.message : "Unable to load documents");
    } finally {
      if (requestVersion === queryVersionRef.current) {
        if (replace) setLoading(false); else setLoadingMore(false);
      }
    }
  }, [search, sourceType, dateFrom, dateTo, dateField, category, tag, sortBy, sortOrder]);

  useEffect(() => {
    void getDocumentFilterOptions().then((data) => setCategoryOptions(data.categories)).catch((error) => console.error("Failed to load filter options:", error));
  }, []);

  useEffect(() => {
    const requestVersion = ++queryVersionRef.current;
    loadMoreRequestedRef.current = false;
    setPage(1);
    setDocuments([]);
    void loadDocuments(1, true, requestVersion);
  }, [loadDocuments]);

  useEffect(() => {
    if (page > 1) {
      void loadDocuments(page, false).finally(() => { loadMoreRequestedRef.current = false; });
    }
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMore = documents.length < total;
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasMore || loading || loadingMore) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadMoreRequestedRef.current) {
        loadMoreRequestedRef.current = true;
        setPage((current) => current + 1);
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore]);
  useEffect(() => {
    const refresh = () => {
      const requestVersion = ++queryVersionRef.current;
      setPage(1);
      void loadDocuments(1, true, requestVersion);
    };
    window.addEventListener("atlas:note-created", refresh);
    window.addEventListener("atlas:note-updated", refresh);
    window.addEventListener("atlas:note-deleted", refresh);
    window.addEventListener("atlas:sync-complete", refresh);
    return () => {
      window.removeEventListener("atlas:note-created", refresh);
      window.removeEventListener("atlas:note-updated", refresh);
      window.removeEventListener("atlas:note-deleted", refresh);
      window.removeEventListener("atlas:sync-complete", refresh);
    };
  }, [loadDocuments]);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await deleteDocument(id);
      setConfirmDelete(null);
      const requestVersion = ++queryVersionRef.current;
      setPage(1);
      await loadDocuments(1, true, requestVersion);
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(null);
    }
  };

  const sourceLabel = (t: string) => {
    const labels: Record<string, string> = { file: "File", url: "URL", manual: "Manual", api: "API" };
    return labels[t] || t;
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Documents</h1>
          <p className="text-muted-foreground mt-1">Browse, edit, and manage your knowledge documents.</p>
        </div>
        <CreateNoteDialog onCreated={() => { const requestVersion = ++queryVersionRef.current; setPage(1); void loadDocuments(1, true, requestVersion); }} />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[280px] flex-[2_1_360px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search titles, content, categories, or tags..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={sourceType} onValueChange={(v) => setSourceType(v || "all")}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Document type" />
              </SelectTrigger>
              <SelectContent>
                {sourceTypes.map((st) => (
                  <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={category} onValueChange={(value) => { setCategory(value || "all"); setTag("all"); }}>
              <SelectTrigger className="w-[190px]"><Tag className="mr-2 h-4 w-4" /><SelectValue placeholder="Primary category" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All categories</SelectItem>{categoryOptions.map((value) => <SelectItem key={value.name} value={value.name}>{value.name}</SelectItem>)}</SelectContent>
            </Select>
            {category !== "all" && <Select value={tag} onValueChange={(value) => setTag(value || "all")}>
              <SelectTrigger className="w-[190px]"><Tag className="mr-2 h-4 w-4" /><SelectValue placeholder="Secondary tag" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All {category} tags</SelectItem>{(categoryOptions.find((item) => item.name === category)?.tags || []).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
            </Select>}
            <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
              <SelectTrigger className="w-[180px]"><ArrowDownUp className="mr-2 h-4 w-4" /><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="note_date">Note date</SelectItem><SelectItem value="system_created">Added to Atlas</SelectItem>
                <SelectItem value="updated_at">Last updated</SelectItem><SelectItem value="title">Title</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={(value) => setSortOrder(value as typeof sortOrder)}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="desc">{sortBy === "title" ? "Z → A" : "Newest first"}</SelectItem><SelectItem value="asc">{sortBy === "title" ? "A → Z" : "Oldest first"}</SelectItem></SelectContent>
            </Select>
            <Select value={dateField} onValueChange={(value) => setDateField(value as typeof dateField)}>
              <SelectTrigger className="w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="note_date">Filter by note date</SelectItem><SelectItem value="system_created">Filter by added date</SelectItem></SelectContent>
            </Select>
            <div className="flex gap-2 items-center">
              <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-full md:w-auto" />
              <span className="text-muted-foreground">to</span>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-full md:w-auto" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Document list */}
      <Card>
        <CardHeader>
          <CardTitle>
            Document list
            <span className="text-sm text-muted-foreground font-normal ml-2">{total} total</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {[...Array(10)].map((_, i) => (<Skeleton key={i} className="h-16 w-full" />))}
            </div>
          ) : loadError ? (
            <div className="py-10 text-center"><p className="text-sm text-red-600">{loadError}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => { const version = ++queryVersionRef.current; void loadDocuments(1, true, version); }}>Retry</Button></div>
          ) : documents.length === 0 ? (
            <div className="py-10 text-center"><p className="text-sm text-muted-foreground">No notes match the current filters.</p><Button variant="ghost" size="sm" className="mt-2" onClick={() => { setSearch(""); setSourceType("all"); setCategory("all"); setTag("all"); setDateFrom(""); setDateTo(""); }}>Clear filters</Button></div>
          ) : (
            <div className="space-y-1">
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="group flex items-center justify-between p-4 rounded-lg hover:bg-accent/50 transition-colors"
                >
                  <div
                    className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                    onClick={() => openDocument(doc.id)}
                  >
                    <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{doc.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">{sourceLabel(doc.source_type)}</Badge>
                        <Badge className="text-xs bg-blue-50 text-blue-700 hover:bg-blue-50">{doc.category}</Badge>
                        <span className="text-xs text-muted-foreground">Written {new Date(doc.note_at).toLocaleString()}</span>
                        {doc.tags.slice(0, 3).map((value) => <Badge key={value} variant="secondary" className="text-[10px]">#{value}</Badge>)}
                        {editingTags === doc.id ? <Input
                          value={tagDraft}
                          onChange={(event) => { setTagDraft(event.target.value); setTagSaveState("idle"); }}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={() => void saveInlineTags(doc.id, true)}
                          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveInlineTags(doc.id, true); } if (event.key === "Escape") setEditingTags(null); }}
                          placeholder="tag, tag"
                          autoFocus
                          className="h-7 w-44 text-xs"
                        /> : <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); setEditingTags(doc.id); setTagDraft(doc.tags.join(", ")); setTagSaveState("idle"); }}
                          className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10px] text-slate-500 opacity-0 transition hover:border-blue-300 hover:text-blue-600 group-hover:opacity-100"
                        >+ tag</button>}
                        {editingTags === doc.id && tagSaveState !== "idle" && <span className={`text-[10px] ${tagSaveState === "error" ? "text-red-500" : tagSaveState === "saved" ? "text-emerald-600" : "text-blue-500"}`}>{tagSaveState === "saving" ? "Saving…" : tagSaveState === "saved" ? "Saved" : "Retry needed"}</span>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition cursor-pointer"
                      onClick={() => openDocument(doc.id)} />

                    {/* Delete button with confirmation */}
                    {confirmDelete === doc.id ? (
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="destructive"
                          onClick={(event) => { event.stopPropagation(); void handleDelete(doc.id); }}
                          disabled={deleting === doc.id}>
                          {deleting === doc.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm"}
                        </Button>
                        <Button size="sm" variant="ghost"
                          onClick={(event) => { event.stopPropagation(); setConfirmDelete(null); }}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button size="icon" variant="ghost"
                        className="h-8 w-8 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(doc.id); }}
                        title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div ref={sentinelRef} className="mt-4 flex min-h-14 items-center justify-center border-t pt-4 text-sm text-muted-foreground">
            {loadingMore ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Loading more notes…</> : hasMore ? "Scroll to load more" : documents.length > 0 ? `All ${total} notes loaded` : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
