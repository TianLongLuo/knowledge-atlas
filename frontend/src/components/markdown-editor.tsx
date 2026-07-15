"use client";

import { useRef, useState } from "react";
import { Bold, Code2, Eye, Heading2, List, Pencil, Quote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/markdown-content";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

type Format = "bold" | "code" | "heading" | "list" | "quote";

export function MarkdownEditor({ value, onChange, placeholder = "Start writing…", className, ariaLabel = "Document content" }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  const applyFormat = (format: Format) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    let next = value;
    let nextStart = start;
    let nextEnd = end;

    if (format === "bold" || format === "code") {
      const marker = format === "bold" ? "**" : "`";
      const fallback = format === "bold" ? "bold text" : "code";
      const inner = selected || fallback;
      next = `${value.slice(0, start)}${marker}${inner}${marker}${value.slice(end)}`;
      nextStart = start + marker.length;
      nextEnd = nextStart + inner.length;
    } else {
      const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const lineEndIndex = value.indexOf("\n", end);
      const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
      const prefix = format === "heading" ? "## " : format === "list" ? "- " : "> ";
      const block = value.slice(lineStart, lineEnd);
      const formatted = block.split("\n").map((line) => `${prefix}${line}`).join("\n");
      next = `${value.slice(0, lineStart)}${formatted}${value.slice(lineEnd)}`;
      nextStart = lineStart + prefix.length;
      nextEnd = lineStart + formatted.length;
    }

    onChange(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextStart, nextEnd);
    });
  };

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200/70 bg-slate-50/55 px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("heading")} title="Heading"><Heading2 className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("bold")} title="Bold"><Bold className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("list")} title="Bulleted list"><List className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("quote")} title="Quote"><Quote className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("code")} title="Inline code"><Code2 className="h-4 w-4" /></Button>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setPreview((current) => !current)} className="h-8 text-xs text-slate-500">
          {preview ? <><Pencil className="mr-1.5 h-3.5 w-3.5" />Write</> : <><Eye className="mr-1.5 h-3.5 w-3.5" />Preview</>}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          <MarkdownContent>{value || "Nothing to preview yet."}</MarkdownContent>
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-0 w-full flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent px-5 py-5 text-[15px] leading-7 text-slate-800 outline-none placeholder:text-slate-400"
        />
      )}
    </div>
  );
}
