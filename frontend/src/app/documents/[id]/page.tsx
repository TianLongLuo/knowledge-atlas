"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getDocument, updateDocument, deleteDocument,
  DocumentDetail,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft, FileText, Calendar, HardDrive,
  Pencil, Trash2, Save, X, Loader2,
} from "lucide-react";

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("content");

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadDoc = async () => {
    setLoading(true);
    try {
      const doc = await getDocument(id);
      setDocument(doc);
      setEditTitle(doc.title);
      setEditContent(doc.content || "");
    } catch (err) {
      console.error("Failed to load:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDoc(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!editTitle.trim()) return;
    setSaving(true);
    try {
      await updateDocument(id, {
        title: editTitle.trim(),
        content: editContent,
      });
      setEditing(false);
      await loadDoc();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
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
        <p className="text-muted-foreground">文档未找到</p>
        <Button variant="outline" onClick={() => router.push("/documents")} className="mt-4">
          <ArrowLeft className="mr-2 h-4 w-4" />返回文档列表
        </Button>
      </div>
    );
  }

  const sourceLabel = (t: string) => {
    const labels: Record<string, string> = { file: "文件", url: "网址", manual: "手动", api: "API", chromadb: "ChromaDB", web: "网页" };
    return labels[t] || t;
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push("/documents")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>

        {editing ? (
          <div className="flex-1 space-y-2">
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="text-xl font-bold bg-background/70"
              placeholder="标题"
            />
          </div>
        ) : (
          <div className="flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{document.title}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline">{sourceLabel(document.source_type)}</Badge>
              {document.status && <Badge variant="secondary">{document.status}</Badge>}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button onClick={handleSave} disabled={saving} size="sm">
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                保存
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setEditTitle(document.title); setEditContent(document.content || ""); }}>
                <X className="h-4 w-4 mr-1" />取消
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4 mr-1" />编辑
              </Button>
              {confirmDelete ? (
                <div className="flex items-center gap-1">
                  <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
                    {deleting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}确认删除
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>取消</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm"
                  className="text-slate-500 hover:text-red-400"
                  onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-4 w-4 mr-1" />删除
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Metadata */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">来源类型</p>
                <p className="text-sm font-medium">{sourceLabel(document.source_type)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">文件大小</p>
                <p className="text-sm font-medium">{formatSize(document.file_size || 0)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">创建时间</p>
                <p className="text-sm font-medium">{new Date(document.created_at).toLocaleString("zh-CN")}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">更新时间</p>
                <p className="text-sm font-medium">{new Date(document.updated_at || document.created_at).toLocaleString("zh-CN")}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">文档内容</CardTitle>
        </CardHeader>
        <CardContent>
          {editing ? (
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[400px] text-sm bg-background/70 resize-y"
              placeholder="文档内容..."
            />
          ) : (
            <div className="note-body max-w-none whitespace-pre-wrap text-sm leading-relaxed">
              {document.content || "无内容"}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
