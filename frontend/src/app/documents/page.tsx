"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getDocuments, deleteDocument, DocumentItem } from "@/lib/api";
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
  FileText, Search, ChevronLeft, ChevronRight,
  ArrowRight, Calendar, Trash2, Loader2,
} from "lucide-react";
import { CreateNoteDialog } from "@/components/create-note-dialog";

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
  const [search, setSearch] = useState("");
  const [sourceType, setSourceType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const router = useRouter();
  const pageSize = 20;

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, page_size: pageSize };
      if (search.trim()) params.search = search.trim();
      if (sourceType !== "all") params.source_type = sourceType;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      const data = await getDocuments(params as Parameters<typeof getDocuments>[0]);
      setDocuments(data.items);
      setTotal(data.total);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoading(false);
    }
  }, [page, search, sourceType, dateFrom, dateTo]);

  useEffect(() => { loadDocuments(); }, [loadDocuments]);

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      await deleteDocument(id);
      setConfirmDelete(null);
      loadDocuments();
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(null);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

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
        <CreateNoteDialog onCreated={loadDocuments} />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search document titles..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>
            <Select value={sourceType} onValueChange={(v) => { setSourceType(v || "all"); setPage(1); }}>
              <SelectTrigger className="w-full md:w-40">
                <SelectValue placeholder="Document type" />
              </SelectTrigger>
              <SelectContent>
                {sourceTypes.map((st) => (
                  <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2 items-center">
              <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className="w-full md:w-auto" />
              <span className="text-muted-foreground">to</span>
              <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} className="w-full md:w-auto" />
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
                    onClick={() => router.push(`/documents/${doc.id}`)}
                  >
                    <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{doc.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">{sourceLabel(doc.source_type)}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.created_at).toLocaleString("en-US")}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition cursor-pointer"
                      onClick={() => router.push(`/documents/${doc.id}`)} />

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

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 mt-4 border-t">
              <p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="h-4 w-4 mr-1" />Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next<ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
