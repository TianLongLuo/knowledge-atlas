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
    <div className={cn("flex min-h-0 flex-col overflow-hidden bg-white", className)}>
      <div className="shrink-0 px-5 pb-2 pt-2.5 sm:px-10">
        <div
          className="flex w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border border-slate-200/80 bg-white/90 p-1 shadow-[0_8px_28px_rgba(15,23,42,.07)] backdrop-blur"
          role="toolbar"
          aria-label="Text formatting"
        >
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("heading")} title="Heading" aria-label="Heading" className="rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-950"><Heading2 className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("bold")} title="Bold" aria-label="Bold" className="rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-950"><Bold className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("list")} title="Bulleted list" aria-label="Bulleted list" className="rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-950"><List className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("quote")} title="Quote" aria-label="Quote" className="rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-950"><Quote className="h-4 w-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => applyFormat("code")} title="Inline code" aria-label="Inline code" className="rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-950"><Code2 className="h-4 w-4" /></Button>
          <span className="mx-1 h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPreview((current) => !current)}
            aria-pressed={preview}
            className={cn("h-8 shrink-0 rounded-lg px-2.5 text-xs", preview ? "bg-blue-50 text-blue-700 hover:bg-blue-100" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800")}
          >
            {preview ? <><Pencil className="mr-1.5 h-3.5 w-3.5" />Continue writing</> : <><Eye className="mr-1.5 h-3.5 w-3.5" />Preview</>}
          </Button>
        </div>
      </div>
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-16 pt-5 [scrollbar-gutter:stable] sm:px-10">
          <MarkdownContent>{value || "Nothing to preview yet."}</MarkdownContent>
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck
          className="min-h-0 w-full flex-1 resize-none overflow-y-auto overscroll-contain bg-transparent px-5 pb-24 pt-4 text-[16px] leading-[1.9] text-slate-800 caret-blue-600 outline-none [scrollbar-gutter:stable] placeholder:text-slate-300 selection:bg-blue-100 sm:px-10"
        />
      )}
    </div>
  );
}
