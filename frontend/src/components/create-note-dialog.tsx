"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Loader2 } from "lucide-react";

interface Props {
  onCreated?: () => void;
}

export function CreateNoteDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleCreate() {
    if (!title.trim() || !content.trim()) return;
    setLoading(true);
    setError("");
    try {
      const token = localStorage.getItem("auth_token");
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: title.trim(), content: content.trim(), source: "web", tags: "" }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "创建失败");
      }
      setOpen(false);
      setTitle("");
      setContent("");
      router.refresh();
      onCreated?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          新建笔记
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-slate-900 border-slate-700 text-white sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white">新建笔记</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder="标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-slate-800 border-slate-700 text-white"
          />
          <Textarea
            placeholder="内容..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            className="bg-slate-800 border-slate-700 text-white resize-none"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <Button
            onClick={handleCreate}
            disabled={loading || !title.trim() || !content.trim()}
            className="w-full"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {loading ? "创建中..." : "保存到知识库"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
