"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BookOpen, Check, Languages, Lightbulb, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getWritingAssistance, WritingAssistResponse, WritingIssue } from "@/lib/api";

interface Props {
  title: string;
  content: string;
  documentId?: number;
  onApplyTitle: (title: string) => void;
}

function IssueList({ items, empty }: { items: WritingIssue[]; empty: string }) {
  if (!items.length) return <p className="text-xs text-slate-500">{empty}</p>;
  return <div className="space-y-2">{items.map((item, index) => (
    <div key={`${item.issue}-${index}`} className="rounded-xl border border-slate-200/80 bg-white/75 p-3 text-xs">
      {item.excerpt && <p className="mb-1 line-clamp-2 italic text-slate-500">“{item.excerpt}”</p>}
      <p className="font-medium text-slate-800">{item.issue}</p>
      <p className="mt-1 leading-5 text-slate-600">{item.suggestion}</p>
    </div>
  ))}</div>;
}

export function AIWritingAssistant({ title, content, documentId, onApplyTitle }: Props) {
  const [result, setResult] = useState<WritingAssistResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const lastSignature = useRef("");
  const requestVersion = useRef(0);

  const analyze = useCallback(async (force = false) => {
    const draft = content.trim();
    if (draft.length < 20) return;
    const signature = `${title.trim()}\u0000${draft}`;
    if (!force && signature === lastSignature.current) return;
    lastSignature.current = signature;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const next = await getWritingAssistance({ title: title.trim(), content: draft, document_id: documentId });
      if (version === requestVersion.current) setResult(next);
    } catch (cause) {
      if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : "Writing analysis failed.");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [content, documentId, title]);

  useEffect(() => {
    if (content.trim().length < 80) return;
    const timer = window.setTimeout(() => void analyze(), 1600);
    return () => window.clearTimeout(timer);
  }, [analyze, content]);

  useEffect(() => {
    if (!result) return;
    setAutoOpen(true);
    const timer = window.setTimeout(() => setAutoOpen(false), 3800);
    return () => window.clearTimeout(timer);
  }, [result]);

  const insightCount = result
    ? result.suggested_titles.length + result.directions.length + result.logic_issues.length + result.grammar_issues.length
    : 0;
  const expanded = hovered || pinned || autoOpen;

  return (
    <div className="fixed right-3 top-[5.5rem] z-[90] sm:right-5 sm:top-24" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <aside aria-hidden={!expanded} className={`absolute right-0 top-2 w-[min(380px,calc(100vw-1.5rem))] origin-top-right rounded-2xl border border-slate-200/90 bg-white/96 p-4 shadow-[0_20px_70px_rgba(30,55,95,.20)] backdrop-blur-xl transition duration-300 ease-out ${expanded ? "pointer-events-auto translate-x-0 scale-100 opacity-100" : "pointer-events-none translate-x-3 scale-95 opacity-0"}`}>
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-blue-600" /><h3 className="text-sm font-semibold text-slate-900">Writing insights</h3></div>
          <Button type="button" size="sm" variant="ghost" onClick={() => void analyze(true)} disabled={loading || content.trim().length < 20} title="Refresh analysis">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        {!result && !loading && !error && <p className="text-xs leading-5 text-slate-500">Keep writing. Atlas analyzes quietly after you pause.</p>}
        {loading && !result && <div className="flex items-center gap-2 py-8 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Reading the draft…</div>}
        {error && <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        {result && <div className="max-h-[min(64vh,620px)] space-y-5 overflow-y-auto pr-1">
        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-blue-700"><Sparkles className="h-3.5 w-3.5" />Suggested titles</div>
          <div className="space-y-2">{result.suggested_titles.map((suggestion) => <button type="button" key={suggestion} onClick={() => onApplyTitle(suggestion)} className="flex w-full items-start justify-between gap-2 rounded-xl border border-blue-100 bg-white/80 p-3 text-left text-sm text-slate-800 transition hover:border-blue-300 hover:bg-white"><span>{suggestion}</span><Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" /></button>)}</div>
        </section>
        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700"><Lightbulb className="h-3.5 w-3.5" />Directions</div>
          <ul className="space-y-2 text-xs leading-5 text-slate-700">{result.directions.map((item) => <li key={item} className="rounded-xl bg-white/70 p-3">{item}</li>)}</ul>
        </section>
        <section>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-violet-700"><BookOpen className="h-3.5 w-3.5" />Historical references</div>
          <div className="space-y-2">{result.historical_references.length ? result.historical_references.map((item) => <div key={item.document_id} className="rounded-xl border border-violet-100 bg-white/75 p-3"><div className="flex items-center justify-between gap-2"><p className="truncate text-xs font-medium text-slate-800">{item.title}</p><Badge variant="outline" className="text-[10px]">{Math.round(item.relevance * 100)}%</Badge></div><p className="mt-1 line-clamp-3 text-xs leading-5 text-slate-500">{item.connection}</p></div>) : <p className="text-xs text-slate-500">No strong historical match found.</p>}</div>
        </section>
        <section><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red-700"><AlertTriangle className="h-3.5 w-3.5" />Logic review</div><IssueList items={result.logic_issues} empty="No clear logical issue found." /></section>
        <section><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-700"><Languages className="h-3.5 w-3.5" />Grammar review</div><IssueList items={result.grammar_issues} empty="No clear grammar issue found." /></section>
        </div>}
      </aside>
      <button
        type="button"
        onClick={() => setPinned((value) => !value)}
        className={`relative z-10 block h-2.5 w-14 rounded-full border shadow-sm backdrop-blur transition-all duration-300 hover:w-20 ${loading ? "animate-pulse border-blue-300 bg-blue-400" : insightCount > 0 ? "border-blue-300 bg-gradient-to-r from-blue-400 to-violet-400" : "border-slate-300 bg-white/90 hover:border-blue-300"}`}
        aria-expanded={expanded}
        aria-label="Open AI writing insights"
        title="AI writing insights"
      >
        <span className="sr-only">AI writing insights{insightCount ? `, ${insightCount} suggestions` : ""}</span>
      </button>
    </div>
  );
}
