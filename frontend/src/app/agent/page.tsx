"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { askAgent, getMemoryInsights, updateMemoryInsight } from "@/lib/api";
import type { AgentResponse, AgentCitation, MemoryInsight } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, User, Send, Loader2, Brain, X, Sparkles, MessageCircleQuestion, Wifi, WifiOff, FileText, ChevronDown, Plus, Pin, Trash2, Pencil, Save, Eye, ShieldCheck, Activity, AlertTriangle } from "lucide-react";
import { MarkdownContent } from "@/components/markdown-content";
import { useNoteReader } from "@/components/note-reader";
import { toast } from "sonner";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: AgentCitation[];
}

const EMPTY_STATE_PROMPTS = [
  { text: "What themes keep recurring in my notes?", icon: Sparkles },
  { text: "Based on my notes, who am I becoming?", icon: Brain },
  { text: "What have I been working on recently?", icon: FileText },
  { text: "What tensions or changes appear in my notes?", icon: MessageCircleQuestion },
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
  const scrollRef = useRef<HTMLDivElement>(null);
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
  }, [messages]);

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

  return (
    <div className="mx-auto flex h-[calc(100dvh-2rem)] min-h-0 max-w-3xl flex-col overflow-hidden md:h-[calc(100dvh-3rem)] lg:h-[calc(100dvh-4rem)]">
      {/* Minimal header */}
      <div className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight">Atlas</h1>
          {connectionError ? (
            <span title="Connection problem"><WifiOff className="h-3.5 w-3.5 text-red-400" /></span>
          ) : (
            <span title="Connected"><Wifi className="h-3.5 w-3.5 text-emerald-400/60" /></span>
          )}
          {docId && (
            <Badge variant="secondary" className="ml-1">
              <FileText className="h-3 w-3 mr-1" />
              Doc-scoped
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" title="Atlas memory" onClick={() => setInsightOpen(true)} className="relative h-8 w-8">
            <Brain className="h-4 w-4" />
            {attentionCount > 0 && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-amber-500" />}
          </Button>
          <Button variant="ghost" size="icon" title="New conversation" onClick={startNewConversation} className="h-8 w-8">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Conversation surface — centered, full-height */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="cyber-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-16">
              <Bot className="h-10 w-10 text-muted-foreground/20 mb-4" />
              <p className="text-muted-foreground text-sm">Ask anything grounded in your knowledge base</p>
              <div className="mt-6 grid gap-2 w-full max-w-sm">
                {EMPTY_STATE_PROMPTS.map((prompt) => (
                  <button
                    key={prompt.text}
                    onClick={() => handleSend(prompt.text)}
                    disabled={loading}
                    className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
                  >
                    <prompt.icon className="h-4 w-4 shrink-0" />
                    <span>{prompt.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6 pb-4">
              {messages.map((msg, idx) => (
                <div key={idx} className="flex gap-3">
                  <div className="shrink-0 mt-1">
                    {msg.role === "user" ? (
                      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center">
                        <User className="h-3.5 w-3.5 text-primary" />
                      </div>
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center">
                        <Bot className="h-3.5 w-3.5 text-blue-400" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground mb-1">
                      {msg.role === "user" ? "You" : "Atlas"}
                    </p>
                    {msg.role === "assistant" ? (
                      <MarkdownContent className="max-w-none">{msg.content}</MarkdownContent>
                    ) : (
                      <div className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</div>
                    )}

                    {/* Citations — collapsed by default */}
                    {msg.citations && msg.citations.length > 0 && (
                      <details className="mt-2 group">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors inline-flex items-center gap-1">
                          <ChevronDown className="h-3 w-3 group-open:rotate-180 transition-transform" />
                          {msg.citations.length} source{msg.citations.length !== 1 ? "s" : ""}
                        </summary>
                        <div className="mt-2 p-2 rounded-lg bg-accent/30 border border-border">
                          <div className="space-y-1.5">
                            {msg.citations.map((cite, ci) => (
                              <button
                                key={ci}
                                className="w-full text-left p-1.5 rounded hover:bg-accent transition-colors flex items-start gap-2"
                                onClick={() =>
                                  openDocument(cite.document_id)
                                }
                              >
                                <div className="min-w-0">
                                  <p className="text-xs font-medium truncate">
                                    {cite.document_title}
                                  </p>
                                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                                    {cite.content}
                                  </p>
                                </div>
                                <Badge variant="outline" className="text-[10px] shrink-0">
                                  {(cite.relevance_score * 100).toFixed(0)}%
                                </Badge>
                              </button>
                            ))}
                          </div>
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center">
                    <Bot className="h-3.5 w-3.5 text-blue-400" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Thinking...</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer remains anchored while only the conversation scrolls. */}
        <div className="z-10 mt-3 shrink-0 border-t bg-background/95 pb-1 pt-3 backdrop-blur">
          {/* Input row */}
          <div className="flex gap-2">
            <textarea
              placeholder="Ask Atlas about your notes or yourself..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              rows={1}
              className="cyber-scrollbar flex min-h-10 max-h-32 flex-1 resize-none rounded-xl border border-input bg-background/80 px-3 py-2 text-sm shadow-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button onClick={() => handleSend()} disabled={loading || !input.trim()} size="icon">
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
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
