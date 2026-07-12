"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { askAgent, getMemoryInsights, reviewMemoryInsight } from "@/lib/api";
import type { AgentResponse, AgentCitation, MemoryInsight } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, User, Send, Loader2, Brain, Check, X, Sparkles, MessageCircleQuestion, Wifi, WifiOff, FileText, ChevronDown, Plus } from "lucide-react";
import { MarkdownContent } from "@/components/markdown-content";
import { useNoteReader } from "@/components/note-reader";

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
  const [mode, setMode] = useState<"knowledge" | "reflection" | "socratic">("knowledge");
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
        mode,
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
  }, [input, loading, sessionId, docId, mode]);

  const reviewInsight = async (id: string, review: "confirmed" | "rejected") => {
    const updated = await reviewMemoryInsight(id, review);
    setInsights((current) => current.map((item) => item.id === id ? updated : item));
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

  const pendingCount = insights.filter((item) => item.status === "pending").length;

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
    <div className="max-w-3xl mx-auto min-h-[calc(100vh-4rem)] flex flex-col">
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
          <Button variant="ghost" size="icon" title="Memory insights" onClick={() => setInsightOpen(true)} className="relative h-8 w-8">
            <Brain className="h-4 w-4" />
            {pendingCount > 0 && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-blue-500" />}
          </Button>
          <Button variant="ghost" size="icon" title="New conversation" onClick={startNewConversation} className="h-8 w-8">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Conversation surface — centered, full-height */}
      <div className="flex-1 flex flex-col min-h-0">
        <ScrollArea className="flex-1 pr-2" ref={scrollRef}>
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
        </ScrollArea>

        {/* Composer with integrated mode selector */}
        <div className="border-t pt-3 mt-3">
          {/* Mode selector — compact pills */}
          <div className="flex items-center gap-1.5 mb-2">
            {([
              ["knowledge", "Knowledge", Bot],
              ["reflection", "Reflection", Sparkles],
              ["socratic", "Socratic", MessageCircleQuestion],
            ] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                onClick={() => setMode(value)}
                title={label}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                  mode === value
                    ? "border-blue-400/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-muted-foreground hover:bg-accent"
                }`}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            ))}
          </div>

          {/* Input row */}
          <div className="flex gap-2">
            <textarea
              placeholder="Ask a question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              rows={1}
              className="flex min-h-10 max-h-32 flex-1 resize-none rounded-xl border border-input bg-background/80 px-3 py-2 text-sm shadow-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
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
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-blue-600" />
              Memory insights
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-3">
            <p className="text-xs text-muted-foreground">
              AI hypotheses never become trusted memory until you confirm them.
            </p>
            {insights.filter((item) => item.status === "pending").length === 0 && (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                No pending insights yet. Reflection conversations can create evidence-backed hypotheses for review.
              </p>
            )}
            {insights.filter((item) => item.status === "pending").map((insight) => (
              <div key={insight.id} className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline">{insight.insight_type}</Badge>
                  <span className="text-[10px] text-muted-foreground">{Math.round(insight.confidence * 100)}% confidence</span>
                </div>
                <p className="mt-2 text-xs leading-5">{insight.statement}</p>
                <p className="mt-2 text-[10px] text-muted-foreground">Evidence: {insight.evidence_document_ids.length} notes</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" className="h-7 flex-1 text-xs" onClick={() => void reviewInsight(insight.id, "confirmed")}>
                    <Check className="mr-1 h-3 w-3" />Confirm
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => void reviewInsight(insight.id, "rejected")}>
                    <X className="mr-1 h-3 w-3" />Reject
                  </Button>
                </div>
              </div>
            ))}
            <div className="border-t pt-3">
              <p className="text-xs font-medium">Confirmed memories</p>
              <p className="mt-1 text-2xl font-semibold">{insights.filter((item) => item.status === "confirmed").length}</p>
              <p className="text-[11px] text-muted-foreground">Only these are included as long-term personal context.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
