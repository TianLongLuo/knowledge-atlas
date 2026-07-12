"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getDocuments, getDocumentFilterOptions, deleteDocument, DocumentItem } from "@/lib/api";
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

const sourceTypes = [
  { value: "all", label: "All types" },
  { value: "file", label: "File" },
  { value: "url", label: "URL" },
  { value: "manual", label: "Manual" },
  { value: "api", label: "API" },
];

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateField, setDateField] = useState<"note_date" | "system_created">("note_date");
  const [tag, setTag] = useState("all");
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<"note_date" | "system_created" | "updated_at" | "title">("note_date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { openDocument } = useNoteReader();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRequestedRef = useRef(false);
  const queryVersionRef = useRef(0);
  const pageSize = 20;

  const loadDocuments = useCallback(async (pageToLoad: number, replace: boolean, requestVersion = queryVersionRef.current) => {
    if (replace) setLoading(true); else setLoadingMore(true);
    try {
      const params: Record<string, string | number> = { page: pageToLoad, page_size: pageSize };
      if (search.trim()) params.search = search.trim();
      if (sourceType !== "all") params.source_type = sourceType;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      params.date_field = dateField;
      if (tag !== "all") params.tag = tag;
      params.sort_by = sortBy;
      params.sort_order = sortOrder;
      const data = await getDocuments(params as Parameters<typeof getDocuments>[0]);
      if (requestVersion !== queryVersionRef.current) return;
      setDocuments((current) => {
        if (replace) return data.items;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...data.items.filter((item) => !seen.has(item.id))];
      });
      setTotal(data.total);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      if (requestVersion === queryVersionRef.current) {
        if (replace) setLoading(false); else setLoadingMore(false);
      }
    }
  }, [search, sourceType, dateFrom, dateTo, dateField, tag, sortBy, sortOrder]);

  useEffect(() => {
    void getDocumentFilterOptions().then((data) => setAvailableTags(data.tags)).catch((error) => console.error("Failed to load filter options:", error));
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
                placeholder="Search document titles..."
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
            <Select value={tag} onValueChange={(value) => setTag(value || "all")}>
              <SelectTrigger className="w-[180px]"><Tag className="mr-2 h-4 w-4" /><SelectValue placeholder="All tags" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All tags</SelectItem>{availableTags.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
            </Select>
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
          ) : documents.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">No documents yet</p>
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
                        <span className="text-xs text-muted-foreground">Written {new Date(doc.note_at).toLocaleString()}</span>
                        {doc.tags.slice(0, 3).map((value) => <Badge key={value} variant="secondary" className="text-[10px]">#{value}</Badge>)}
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
