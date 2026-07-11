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
import { createNote } from "@/lib/api";

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
      await createNote({ title: title.trim(), content: content.trim(), source: "manual", tags: "" });
      setOpen(false);
      setTitle("");
      setContent("");
      router.refresh();
      onCreated?.();
    } catch (e: unknown) {
      setError(`${e instanceof Error ? e.message : "Create failed"}. Check the network and try again; your draft is still here.`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          New note
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border/80 bg-popover/95 text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-background/70"
          />
          <Textarea
            placeholder="Content..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            className="bg-background/70 resize-none"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <Button
            onClick={handleCreate}
            disabled={loading || !title.trim() || !content.trim()}
            className="w-full"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {loading ? "Creating..." : "Save to knowledge base"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
