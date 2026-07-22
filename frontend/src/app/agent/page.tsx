"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { askAgent, getMemoryInsights, updateMemoryInsight } from "@/lib/api";
import type { AgentResponse, AgentCitation, MemoryInsight } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ClipboardCopy,
  Database,
  Eye,
  FileSearch,
  FileText,
  GitCompareArrows,
  Lightbulb,
  ListChecks,
  Loader2,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  WandSparkles,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { MarkdownContent } from "@/components/markdown-content";
import { useNoteReader } from "@/components/note-reader";
import { toast } from "sonner";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: AgentCitation[];
}

const ASSISTANT_ACTIONS = [
  {
    label: "Search my knowledge",
    description: "Find facts, ideas, and passages across every note",
    prompt: "Search across my knowledge base for ",
    icon: Search,
  },
  {
    label: "Summarize my recent thinking",
    description: "Synthesize what has changed across recent notes",
    prompt: "Summarize my recent thinking, including recurring themes and important changes.",
    icon: FileText,
  },
  {
    label: "Find connections",
    description: "Connect related ideas that may be easy to miss",
    prompt: "Find meaningful connections, agreements, and tensions across my notes.",
    icon: GitCompareArrows,
  },
  {
    label: "Help me think",
    description: "Challenge assumptions and expose blind spots",
    prompt: "Help me think through an important question using my notes as evidence: ",
    icon: Lightbulb,
  },
  {
    label: "Make a plan",
    description: "Turn what I know into concrete next steps",
    prompt: "Based on my notes, create a practical plan for ",
    icon: ListChecks,
  },
  {
    label: "Reflect on me",
    description: "Show patterns in my goals, choices, and beliefs",
    prompt: "Based on my notes, what patterns do you see in who I am becoming? Separate evidence from inference.",
    icon: Brain,
  },
];

const FOLLOW_UP_ACTIONS = [
  { label: "Go deeper", prompt: "Go deeper. What important nuance or implication did we miss?" },
  { label: "Show the evidence", prompt: "Show the strongest evidence from my notes for this answer." },
  { label: "Turn it into a plan", prompt: "Turn this into a concise, practical action plan." },
];

export default function AgentPage() {
  const searchParams = useSearchParams();
  const { openDocument } = useNoteReader();
  const docId = searchParams.get("doc");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [insights, setInsights] = useState<MemoryInsight[]>([]);
  const [insightOpen, setInsightOpen] = useState(false);
  const [editingInsightId, setEditingInsightId] = useState<string | null>(null);
  const [editingStatement, setEditingStatement] = useState("");
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const [chatHydrated, setChatHydrated] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [copiedMessage, setCopiedMessage] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const justSentDoc = useRef(false);

  useEffect(() => {
    try {
      const storedSession = window.localStorage.getItem("atlas:chat-session");
      const storedMessages = window.localStorage.getItem("atlas:chat-messages");
      if (storedSession) setSessionId(storedSession);
      if (storedMessages) setMessages(JSON.parse(storedMessages) as ChatMessage[]);
    } catch {
      // A private browser context may disable localStorage; chat still works.
    } finally {
      setChatHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!chatHydrated) return;
    try {
      if (sessionId) window.localStorage.setItem("atlas:chat-session", sessionId);
      window.localStorage.setItem("atlas:chat-messages", JSON.stringify(messages.slice(-40)));
    } catch {
      // Persistence is an enhancement, not a requirement for sending messages.
    }
  }, [chatHydrated, messages, sessionId]);

  useEffect(() => {
    void getMemoryInsights().then(setInsights).catch(() => setInsights([]));
  }, []);

  // Auto-send doc-scoped query if navigated from graph reader
  useEffect(() => {
    if (docId && !justSentDoc.current) {
      justSentDoc.current = true;
      const timer = setTimeout(() => {
        // Dispatch doc-scoped query to be handled by the send function
        window.dispatchEvent(new CustomEvent("atlas:auto-send", {
          detail: `Analyze this document`
        }));
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [docId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 48), 160)}px`;
  }, [input]);

  useEffect(() => {
    if (!commandOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(event.target as Node)) {
        setCommandOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [commandOpen]);

  const handleSend = useCallback(async (overrideInput?: string) => {
    const question = (overrideInput ?? input).trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);
    setConnectionError(false);

    try {
      const response: AgentResponse = await askAgent({
        question,
        session_id: sessionId || undefined,
        document_id: docId || undefined,
      });

      if (!sessionId) {
        setSessionId(response.session_id);
      }
      void getMemoryInsights().then(setInsights).catch(() => undefined);

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: response.answer,
          citations: response.citations,
        },
      ]);
    } catch (err) {
      setConnectionError(true);
      const message = err instanceof Error ? err.message : "Request failed";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Sorry, something went wrong: ${message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, sessionId, docId]);

  const applyMemoryAction = async (
    id: string,
    action: "confirm" | "reject" | "pin" | "forget" | "correct",
    statement?: string,
  ) => {
    setMemoryBusy(id);
    try {
      const updated = await updateMemoryInsight(id, action, statement);
      setInsights((current) => current.map((item) => item.id === id ? updated : item));
      setEditingInsightId(null);
      setEditingStatement("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update this memory");
    } finally {
      setMemoryBusy(null);
    }
  };

  // Listen for auto-send events (from doc-scoped navigation)
  useEffect(() => {
    const handler = (e: Event) => {
      const question = (e as CustomEvent).detail as string;
      if (question) handleSend(question);
    };
    window.addEventListener("atlas:auto-send", handler);
    return () => window.removeEventListener("atlas:auto-send", handler);
  }, [handleSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && commandOpen) {
      e.preventDefault();
      setCommandOpen(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const attentionCount = insights.filter((item) => item.status === "pending" && item.requires_review).length;
  const trustedInsights = insights.filter((item) => item.status === "confirmed");
  const emergingInsights = insights.filter((item) => item.status === "pending" && !item.requires_review);
  const attentionInsights = insights.filter((item) => item.status === "pending" && item.requires_review);

  const startNewConversation = () => {
    setMessages([]);
    setSessionId(null);
    try {
      window.localStorage.removeItem("atlas:chat-session");
      window.localStorage.removeItem("atlas:chat-messages");
    } catch {
      // Ignore unavailable local storage.
    }
  };

  const chooseAction = (prompt: string) => {
    setInput(prompt);
    setCommandOpen(false);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  };

  const copyAnswer = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessage(index);
      window.setTimeout(() => setCopiedMessage((current) => current === index ? null : current), 1600);
    } catch {
      toast.error("Could not copy this answer");
    }
  };

  const lastAssistantIndex = messages.reduce(
    (last, message, index) => message.role === "assistant" ? index : last,
    -1,
  );

  return (
    <div className="mx-auto flex h-[calc(100dvh-2rem)] min-h-0 w-full max-w-5xl flex-col overflow-hidden md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-4rem)]">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200/70 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/80 bg-white/65 shadow-sm backdrop-blur">
            <WandSparkles className="h-4 w-4 text-slate-700" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900">Atlas AI</h1>
              {connectionError ? (
                <span title="Connection problem"><WifiOff className="h-3.5 w-3.5 text-red-400" /></span>
              ) : (
                <span title="Connected"><Wifi className="h-3.5 w-3.5 text-emerald-500/70" /></span>
              )}
            </div>
            <p className="hidden text-[11px] text-slate-500 sm:block">
              {docId ? "Using this note and your knowledge base" : "Grounded in your notes and memory"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" title="Atlas memory" onClick={() => setInsightOpen(true)} className="relative text-slate-600 hover:bg-white/60">
            <Brain className="h-4 w-4" />
            <span className="hidden sm:inline">Memory</span>
            {attentionCount > 0 && <span className="absolute right-1 top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" />}
          </Button>
          <Button variant="ghost" size="sm" title="New conversation" onClick={startNewConversation} className="text-slate-600 hover:bg-white/60">
            <RotateCcw className="h-4 w-4" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="cyber-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-1 py-8 sm:px-6">
              <div className="mb-7">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/90 bg-white/70 shadow-[0_10px_35px_rgba(46,74,117,.10)] backdrop-blur-xl">
                  <Sparkles className="h-5 w-5 text-blue-600" />
                </div>
                <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">What can I help you think through?</h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
                  Ask naturally. Atlas searches your notes, connects the evidence, and remembers what matters over time.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ASSISTANT_ACTIONS.slice(0, 4).map((action) => (
                  <button
                    key={action.label}
                    onClick={() => chooseAction(action.prompt)}
                    disabled={loading}
                    className="group flex items-start gap-3 rounded-2xl border border-slate-200/70 bg-white/45 p-3.5 text-left shadow-[0_5px_22px_rgba(55,84,130,.045)] backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white/75 hover:shadow-[0_10px_30px_rgba(55,84,130,.08)] disabled:opacity-50"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-900/[.045] text-slate-600 transition-colors group-hover:bg-blue-500/10 group-hover:text-blue-600">
                      <action.icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-800">{action.label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-slate-500">{action.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-8 px-1 py-7 sm:px-6 sm:py-10">
              {messages.map((msg, idx) => (
                <article key={idx} className={msg.role === "user" ? "flex justify-end" : "group/answer"}>
                  {msg.role === "user" ? (
                    <div className="max-w-[88%] rounded-[18px] rounded-br-md border border-slate-200/70 bg-white/55 px-4 py-2.5 text-sm leading-6 text-slate-800 shadow-sm backdrop-blur sm:max-w-[78%]">
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-slate-500">
                        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600"><WandSparkles className="h-3.5 w-3.5" /></span>
                        Atlas
                      </div>
                      <MarkdownContent className="max-w-none">{msg.content}</MarkdownContent>

                      {msg.citations && msg.citations.length > 0 && (
                        <details className="group/sources mt-4 rounded-xl border border-transparent open:border-slate-200/70 open:bg-white/35">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-white/70 hover:text-slate-800 [&::-webkit-details-marker]:hidden">
                            <FileSearch className="h-3.5 w-3.5" />
                            {msg.citations.length} source{msg.citations.length !== 1 ? "s" : ""}
                            <ChevronDown className="h-3 w-3 transition-transform group-open/sources:rotate-180" />
                          </summary>
                          <div className="grid gap-1.5 p-2 sm:grid-cols-2">
                            {msg.citations.map((cite, ci) => (
                              <button
                                key={`${cite.document_id}-${ci}`}
                                className="flex min-w-0 items-start gap-2 rounded-lg p-2 text-left transition-colors hover:bg-white/80"
                                onClick={() => openDocument(cite.document_id)}
                              >
                                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-xs font-medium text-slate-700">{cite.document_title}</span>
                                  <span className="mt-0.5 block line-clamp-1 text-[11px] text-slate-500">{cite.content}</span>
                                </span>
                                <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{Math.round(cite.relevance_score * 100)}%</span>
                              </button>
                            ))}
                          </div>
                        </details>
                      )}

                      <div className="mt-3 flex flex-wrap items-center gap-1 text-slate-400 opacity-60 transition-opacity group-hover/answer:opacity-100">
                        <Button variant="ghost" size="icon-xs" title="Copy answer" onClick={() => void copyAnswer(msg.content, idx)}>
                          {copiedMessage === idx ? <Check className="text-emerald-600" /> : <ClipboardCopy />}
                        </Button>
                        <Button variant="ghost" size="icon-xs" title="Helpful" onClick={() => toast.success("Thanks for the feedback")}><ThumbsUp /></Button>
                        <Button variant="ghost" size="icon-xs" title="Not helpful" onClick={() => toast.message("Thanks — ask a follow-up to correct the answer")}><ThumbsDown /></Button>
                      </div>

                      {idx === lastAssistantIndex && !loading && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {FOLLOW_UP_ACTIONS.map((action) => (
                            <button key={action.label} onClick={() => void handleSend(action.prompt)} className="rounded-full border border-slate-200/80 bg-white/40 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-slate-300 hover:bg-white/80 hover:text-slate-900">
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              ))}

              {loading && (
                <div className="flex items-center gap-3 text-sm text-slate-500">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600"><WandSparkles className="h-3.5 w-3.5 animate-pulse" /></span>
                  <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />Searching your knowledge and thinking…</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="relative z-20 shrink-0 bg-gradient-to-t from-background via-background/96 to-transparent px-0 pb-1 pt-4 sm:px-5">
          <div ref={composerRef} className="relative mx-auto w-full max-w-3xl">
            {commandOpen && (
              <div className="absolute bottom-[calc(100%+10px)] left-0 z-30 w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 p-2 shadow-[0_24px_80px_rgba(30,50,85,.18)] backdrop-blur-2xl animate-in fade-in-0 slide-in-from-bottom-2">
                <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">Ask Atlas to…</div>
                {ASSISTANT_ACTIONS.map((action) => (
                  <button key={action.label} onClick={() => chooseAction(action.prompt)} className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-slate-100/80">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-900/[.045] text-slate-500 group-hover:text-blue-600"><action.icon className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-800">{action.label}</span><span className="block truncate text-xs text-slate-500">{action.description}</span></span>
                  </button>
                ))}
              </div>
            )}

            <div className="rounded-[22px] border border-slate-200/90 bg-white/82 p-2 shadow-[0_16px_55px_rgba(41,66,104,.14),0_2px_10px_rgba(41,66,104,.06)] backdrop-blur-2xl transition-shadow focus-within:border-slate-300 focus-within:shadow-[0_20px_70px_rgba(41,66,104,.18),0_0_0_3px_rgba(59,130,246,.07)]">
              <textarea
                ref={textareaRef}
                aria-label="Ask Atlas"
                placeholder="Ask Atlas about your notes or yourself…"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  if (event.target.value === "/") setCommandOpen(true);
                }}
                onKeyDown={handleKeyDown}
                disabled={loading}
                rows={1}
                className="cyber-scrollbar block min-h-12 max-h-40 w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-6 text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Button variant="ghost" size="icon-sm" title="Show actions" aria-label="Show assistant actions" onClick={() => setCommandOpen((open) => !open)} className="rounded-xl text-slate-500 hover:bg-slate-100">
                    <Plus className={`transition-transform ${commandOpen ? "rotate-45" : ""}`} />
                  </Button>
                  <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-slate-100/80 px-2 py-1 text-[11px] text-slate-500">
                    <Database className="h-3 w-3 shrink-0" />
                    <span className="truncate">{docId ? "This note + all knowledge" : "All knowledge"}</span>
                  </span>
                </div>
                <Button onClick={() => void handleSend()} disabled={loading || !input.trim()} size="icon-sm" title="Send" className="rounded-xl bg-slate-900 text-white shadow-sm hover:bg-slate-700">
                  {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                </Button>
              </div>
            </div>
            <p className="mt-1.5 text-center text-[10px] text-slate-400">Enter to send · Shift + Enter for a new line · Use + or / for actions</p>
          </div>
        </div>
      </div>

      {/* Memory insight drawer */}
      <Dialog open={insightOpen} onOpenChange={setInsightOpen}>
        <DialogContent className="max-h-[88vh] overflow-hidden sm:max-w-xl">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4 pr-7">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Brain className="h-4 w-4 text-blue-600" />
                  Atlas memory
                </DialogTitle>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Learns quietly from saved notes and your own messages. Facts are trusted only when directly stated; inferred patterns stay tentative.
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 border-emerald-500/25 bg-emerald-500/5 text-emerald-600">
                <Activity className="mr-1 h-3 w-3" />Automatic
              </Badge>
            </div>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-1">
            <div className="rounded-xl border bg-emerald-500/[0.035] p-3">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />Trusted facts</p>
              <p className="mt-1 text-xl font-semibold">{trustedInsights.length}</p>
            </div>
            <div className="rounded-xl border bg-blue-500/[0.035] p-3">
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-blue-500" />Emerging patterns</p>
              <p className="mt-1 text-xl font-semibold">{emergingInsights.length}</p>
            </div>
          </div>
          <div className="cyber-scrollbar max-h-[58vh] space-y-5 overflow-y-auto pr-1">
            {attentionInsights.length > 0 && (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" />Needs your input
                </h3>
                <div className="space-y-2">
                  {attentionInsights.map((insight) => (
                    <div key={insight.id} className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline">{insight.insight_type}</Badge>
                        <span className="text-[10px] text-muted-foreground">Possible conflict or sensitive inference</span>
                      </div>
                      {editingInsightId === insight.id ? (
                        <div className="mt-2 space-y-2">
                          <textarea value={editingStatement} onChange={(event) => setEditingStatement(event.target.value)} rows={3} className="w-full resize-none rounded-lg border bg-background p-2 text-xs leading-5 outline-none focus:ring-2 focus:ring-blue-500/20" />
                          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingInsightId(null)}><X className="h-3.5 w-3.5" /></Button><Button size="sm" className="h-7 px-2 text-xs" disabled={!editingStatement.trim() || memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "correct", editingStatement)}><Save className="mr-1 h-3 w-3" />Save</Button></div>
                        </div>
                      ) : (
                        <>
                          <p className="mt-2 text-xs leading-5">{insight.statement}</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" className="h-7 text-xs" disabled={memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "pin")}>
                              <Pin className="mr-1 h-3 w-3" />Keep as true
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEditingInsightId(insight.id); setEditingStatement(insight.statement); }}>
                              <Pencil className="mr-1 h-3 w-3" />Correct
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "forget")}>
                              <Trash2 className="mr-1 h-3 w-3" />Forget
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />What Atlas knows
              </h3>
              {trustedInsights.length === 0 ? (
                <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">Trusted facts will appear as you write and talk with Atlas.</p>
              ) : (
                <div className="space-y-2">
                  {trustedInsights.map((insight) => (
                    <div key={insight.id} className="group rounded-xl border bg-background/70 p-3">
                      {editingInsightId === insight.id ? (
                        <div className="space-y-2">
                          <textarea value={editingStatement} onChange={(event) => setEditingStatement(event.target.value)} rows={3} className="w-full resize-none rounded-lg border bg-background p-2 text-xs leading-5 outline-none focus:ring-2 focus:ring-blue-500/20" />
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingInsightId(null)}><X className="h-3.5 w-3.5" /></Button>
                            <Button size="sm" className="h-7 px-2 text-xs" disabled={!editingStatement.trim() || memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "correct", editingStatement)}><Save className="mr-1 h-3 w-3" />Save</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5"><Badge variant="outline">{insight.insight_type}</Badge>{insight.pinned && <Pin className="h-3 w-3 text-blue-500" />}{insight.stale && <Badge variant="secondary">stale</Badge>}</div>
                            <span className="text-[10px] text-muted-foreground">{insight.evidence_document_ids.length} source{insight.evidence_document_ids.length === 1 ? "" : "s"}</span>
                          </div>
                          <p className="mt-2 text-xs leading-5">{insight.statement}</p>
                          <div className="mt-2 flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                            {insight.evidence_document_ids[0] && <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => openDocument(insight.evidence_document_ids[0])}><Eye className="mr-1 h-3 w-3" />Source</Button>}
                            {!insight.pinned && <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "pin")}><Pin className="mr-1 h-3 w-3" />Pin</Button>}
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => { setEditingInsightId(insight.id); setEditingStatement(insight.statement); }}><Pencil className="mr-1 h-3 w-3" />Correct</Button>
                            <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-[11px] text-muted-foreground hover:text-red-500" disabled={memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "forget")}><Trash2 className="h-3 w-3" /></Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {emergingInsights.length > 0 && (
              <section>
                <h3 className="mb-1 flex items-center gap-1.5 text-xs font-medium"><Sparkles className="h-3.5 w-3.5 text-blue-500" />Emerging patterns</h3>
                <p className="mb-2 text-[11px] leading-4 text-muted-foreground">Used only as tentative context. Repetition strengthens them; inactivity lets them fade.</p>
                <div className="space-y-2">
                  {emergingInsights.map((insight) => (
                    <div key={insight.id} className="group rounded-xl border border-blue-500/15 bg-blue-500/[0.025] p-3">
                      {editingInsightId === insight.id ? (
                        <div className="space-y-2">
                          <textarea value={editingStatement} onChange={(event) => setEditingStatement(event.target.value)} rows={3} className="w-full resize-none rounded-lg border bg-background p-2 text-xs leading-5 outline-none focus:ring-2 focus:ring-blue-500/20" />
                          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingInsightId(null)}><X className="h-3.5 w-3.5" /></Button><Button size="sm" className="h-7 px-2 text-xs" disabled={!editingStatement.trim() || memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "correct", editingStatement)}><Save className="mr-1 h-3 w-3" />Save</Button></div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center justify-between gap-2"><Badge variant="outline">{insight.insight_type}</Badge><span className="text-[10px] text-muted-foreground">seen {insight.occurrences}× · {Math.round(insight.confidence * 100)}%</span></div>
                          <p className="mt-2 text-xs leading-5">{insight.statement}</p>
                          <div className="mt-2 flex gap-1 opacity-70 transition-opacity group-hover:opacity-100">
                            {insight.evidence_document_ids[0] && <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => openDocument(insight.evidence_document_ids[0])}><Eye className="mr-1 h-3 w-3" />Source</Button>}
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "pin")}><Pin className="mr-1 h-3 w-3" />Make fact</Button>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => { setEditingInsightId(insight.id); setEditingStatement(insight.statement); }}><Pencil className="mr-1 h-3 w-3" />Correct</Button>
                            <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-muted-foreground hover:text-red-500" disabled={memoryBusy === insight.id} onClick={() => void applyMemoryAction(insight.id, "forget")}><Trash2 className="h-3 w-3" /></Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
