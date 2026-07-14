"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Loader2 } from "lucide-react";
import { createNote, getDocumentFilterOptions } from "@/lib/api";
import { AIWritingAssistant } from "@/components/ai-writing-assistant";

interface Props {
  onCreated?: () => void;
}

export function CreateNoteDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [assistantExpanded, setAssistantExpanded] = useState(false);
  const router = useRouter();

  useEffect(() => {
    void getDocumentFilterOptions().then((data) => setCategories(data.categories.map((item) => item.name))).catch(() => undefined);
  }, []);

  async function handleCreate() {
    if (!title.trim() || !content.trim()) return;
    setLoading(true);
    setError("");
    try {
      await createNote({ title: title.trim(), content, source: "manual", tags: tags.trim(), category });
      setOpen(false);
      setTitle("");
      setContent("");
      setTags("");
      setCategory("");
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
      <DialogTrigger render={<Button className="gap-2" />}>
        <Plus className="h-4 w-4" />
        New note
      </DialogTrigger>
      <DialogContent className="max-h-[94vh] overflow-y-auto border-border/80 bg-popover/95 text-foreground sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>New note</DialogTitle>
        </DialogHeader>
        <div className="relative mx-auto min-h-[42vh] w-full max-w-[1020px]">
          <div className={`mx-auto w-full max-w-[650px] transform-gpu space-y-4 transition-transform duration-300 ease-out ${assistantExpanded ? "lg:-translate-x-[185px]" : "translate-x-0"}`}>
            <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} className="bg-background/70" />
            <Textarea placeholder="Content..." value={content} onChange={(e) => setContent(e.target.value)} rows={16} className="min-h-[42vh] max-h-[65vh] bg-background/70 resize-y leading-7" />
            <p className="text-right text-xs text-muted-foreground">{content.length.toLocaleString()} characters</p>
            <Select value={category} onValueChange={(value) => setCategory(value || "")}>
              <SelectTrigger><SelectValue placeholder="Primary category (optional)" /></SelectTrigger>
              <SelectContent>{categories.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
            </Select>
            <Input placeholder="Secondary tags, separated by commas" value={tags} onChange={(event) => setTags(event.target.value)} className="bg-background/70" />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <Button onClick={handleCreate} disabled={loading || !title.trim() || !content.trim()} className="w-full">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}{loading ? "Creating..." : "Save to knowledge base"}
            </Button>
          </div>
          <div className="absolute inset-y-0 right-0 z-10 flex items-start">
            <AIWritingAssistant title={title} content={content} onApplyTitle={setTitle} onExpandedChange={setAssistantExpanded} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
