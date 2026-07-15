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
  const [justUpdated, setJustUpdated] = useState(false);
  const lastSignature = useRef("");
  const requestVersion = useRef(0);
  const hoverTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);

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
    setJustUpdated(true);
    const timer = window.setTimeout(() => setJustUpdated(false), 2200);
    return () => window.clearTimeout(timer);
  }, [result]);

  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
  }, []);

  const insightCount = result
    ? result.suggested_titles.length + result.directions.length + result.logic_issues.length + result.grammar_issues.length
    : 0;
  const expanded = hovered || pinned;

  const openAfterIntent = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    if (pinned || hovered) return;
    hoverTimer.current = window.setTimeout(() => setHovered(true), 180);
  };

  const closeAfterLeave = () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (pinned) return;
    leaveTimer.current = window.setTimeout(() => setHovered(false), 700);
  };

  const keepOpen = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    setHovered(true);
  };

  return (
    <div
      className="pointer-events-none flex h-full min-h-0 w-[360px] max-w-[calc(100vw-2rem)] shrink-0 items-stretch overflow-hidden"
    >
      <aside
        aria-hidden={!expanded}
        onMouseEnter={keepOpen}
        onMouseLeave={closeAfterLeave}
        className={`min-h-0 min-w-0 flex-1 overflow-hidden overscroll-contain rounded-2xl border border-transparent bg-transparent shadow-none transition-[opacity,transform] duration-700 ease-out ${expanded ? "pointer-events-auto mr-2 translate-x-0 opacity-100" : "translate-x-8 opacity-0"}`}
      >
        <div className="flex h-full min-h-0 min-w-[250px] flex-col rounded-2xl bg-white/68 p-4 backdrop-blur-md">
        <div className="mb-4 flex shrink-0 items-center justify-between gap-2">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-blue-600" /><h3 className="text-sm font-semibold text-slate-900">Writing insights</h3></div>
          <Button type="button" size="sm" variant="ghost" onClick={() => void analyze(true)} disabled={loading || content.trim().length < 20} title="Refresh analysis">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        {!result && !loading && !error && <p className="text-xs leading-5 text-slate-500">Keep writing. Atlas analyzes quietly after you pause.</p>}
        {loading && !result && <div className="flex items-center gap-2 py-8 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Reading the draft…</div>}
        {error && <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        {result && <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pr-1">
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
        </div>
      </aside>
      <button
        type="button"
        onClick={() => setPinned((value) => {
          if (value) setHovered(false);
          return !value;
        })}
        onMouseEnter={openAfterIntent}
        onMouseLeave={closeAfterLeave}
        className={`pointer-events-auto sticky top-3 block h-28 w-3 shrink-0 rounded-full border shadow-sm backdrop-blur transition-all duration-300 hover:w-3.5 ${loading || justUpdated ? "animate-pulse border-blue-300 bg-blue-400 shadow-[0_0_18px_rgba(96,165,250,.55)]" : insightCount > 0 ? "border-blue-300 bg-gradient-to-b from-blue-400 to-violet-400" : "border-slate-300 bg-white/90 hover:border-blue-300"}`}
        aria-expanded={expanded}
        aria-label={expanded ? "Close AI writing insights" : "Open AI writing insights"}
        title="AI writing insights"
      >
        <span className="sr-only">AI writing insights{insightCount ? `, ${insightCount} suggestions` : ""}</span>
      </button>
    </div>
  );
}
