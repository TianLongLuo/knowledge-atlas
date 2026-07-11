"use client";

import { useState, useRef, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { askAgent, getAgentMemoryStatus, getAgentStatus, getMemoryInsights, reviewMemoryInsight } from "@/lib/api";
import type { AgentMemoryStatus, AgentResponse, AgentCitation, AgentStatus, MemoryInsight } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, Loader2, FileText, ExternalLink, Brain, Check, X, Sparkles, MessageCircleQuestion } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: AgentCitation[];
}

export default function AgentPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const docId = searchParams.get("doc");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(() => docId ? `Analyze this document (${docId})` : "");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<AgentMemoryStatus | null>(null);
  const [insights, setInsights] = useState<MemoryInsight[]>([]);
  const [mode, setMode] = useState<"knowledge" | "reflection" | "socratic">("knowledge");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getAgentStatus().then(setStatus).catch(() => setStatus(null));
    void getAgentMemoryStatus().then(setMemoryStatus).catch(() => setMemoryStatus(null));
    void getMemoryInsights().then(setInsights).catch(() => setInsights([]));
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const question = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

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
      void getAgentMemoryStatus(response.session_id).then(setMemoryStatus).catch(() => undefined);
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
      const message = err instanceof Error ? err.message : "Request failed";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${message}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const reviewInsight = async (id: string, review: "confirmed" | "rejected") => {
    const updated = await reviewMemoryInsight(id, review);
    setInsights((current) => current.map((item) => item.id === id ? updated : item));
    void getAgentMemoryStatus(sessionId || undefined).then(setMemoryStatus).catch(() => undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="max-w-5xl mx-auto min-h-[calc(100vh-6rem)] flex flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">AI Assistant</h1>
        <p className="text-muted-foreground mt-1">
          Ask questions and get answers grounded in your knowledge base.
        </p>
        {status && (
          <p className={`mt-2 text-xs ${status.deepseek_available && status.vector_store_available ? "text-emerald-700" : "text-amber-700"}`}>
            DeepSeek {status.deepseek_available ? "connected" : status.deepseek_configured ? "configured but unreachable" : "not configured"} · {status.vector_store_available ? `Vector store ready (${status.vector_document_count} vectors)` : "Vector store empty or unavailable"}
            {status.deepseek_error ? ` · ${status.deepseek_error}` : ""}
          </p>
        )}
        {docId && (
          <Badge variant="secondary" className="mt-2">
            <FileText className="h-3 w-3 mr-1" />
            Document-scoped mode
          </Badge>
        )}
        {memoryStatus && (
          <div className="mt-4 grid gap-2 md:grid-cols-4">
            {memoryStatus.levels.map((level) => (
              <div key={level.level} className="rounded-lg border border-border bg-card/70 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold"><span className="mr-1 text-blue-600">{level.level}</span>{level.title}</p>
                  <Badge variant="outline">{level.count}</Badge>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{level.description}</p>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {([
            ["knowledge", "Knowledge", Bot, "Answer from your notes"],
            ["reflection", "Reflection", Sparkles, "Surface patterns and changes"],
            ["socratic", "Socratic", MessageCircleQuestion, "Clarify assumptions through questions"],
          ] as const).map(([value, label, Icon, description]) => (
            <button key={value} onClick={() => setMode(value)} title={description} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${mode === value ? "border-blue-500 bg-blue-500/10 text-blue-700" : "border-border bg-card text-muted-foreground hover:bg-accent"}`}>
              <Icon className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <Card className="flex min-h-[560px] flex-col">
        <CardContent className="flex-1 flex flex-col min-h-0 pt-6">
          {/* Messages */}
          <ScrollArea className="flex-1 pr-4" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <Bot className="h-12 w-12 text-muted-foreground/30 mb-4" />
                <p className="text-muted-foreground">Start a conversation</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Ask from the knowledge base and review cited sources.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {messages.map((msg, idx) => (
                  <div key={idx} className="flex gap-3">
                    <div className="shrink-0 mt-1">
                      {msg.role === "user" ? (
                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                          <Bot className="h-4 w-4 text-blue-400" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground mb-1">
                        {msg.role === "user" ? "You" : "AI Assistant"}
                      </p>
                      <div className="text-sm whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </div>

                      {/* Citations */}
                      {msg.citations && msg.citations.length > 0 && (
                        <div className="mt-3 p-3 rounded-lg bg-accent/50 border border-border">
                          <p className="text-xs font-medium text-muted-foreground mb-2">
                            Sources
                          </p>
                          <div className="space-y-2">
                            {msg.citations.map((cite, ci) => (
                              <button
                                key={ci}
                                className="w-full text-left p-2 rounded hover:bg-accent transition-colors flex items-start gap-2"
                                onClick={() =>
                                  router.push(`/documents/${cite.document_id}`)
                                }
                              >
                                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                                <div className="min-w-0">
                                  <p className="text-xs font-medium truncate">
                                    {cite.document_title}
                                  </p>
                                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                                    {cite.content}
                                  </p>
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] mt-1"
                                  >
                                    Relevance: {(cite.relevance_score * 100).toFixed(0)}%
                                  </Badge>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {loading && (
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                      <Bot className="h-4 w-4 text-blue-400" />
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

          {/* Input */}
          <div className="flex gap-2 pt-4 border-t mt-4">
            <Input
              placeholder="Ask a question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
              className="flex-1"
            />
            <Button onClick={handleSend} disabled={loading || !input.trim()}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      <aside className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2"><Brain className="h-4 w-4 text-blue-600" /><h2 className="text-sm font-semibold">About You · review queue</h2></div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">AI hypotheses never become trusted memory until you confirm them.</p>
        <div className="mt-4 space-y-3">
          {insights.filter((item) => item.status === "pending").length === 0 && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No pending insights yet. Reflection conversations can create evidence-backed hypotheses for review.</p>}
          {insights.filter((item) => item.status === "pending").map((insight) => (
            <div key={insight.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-center justify-between gap-2"><Badge variant="outline">{insight.insight_type}</Badge><span className="text-[10px] text-muted-foreground">{Math.round(insight.confidence * 100)}% confidence</span></div>
              <p className="mt-2 text-xs leading-5">{insight.statement}</p>
              <p className="mt-2 text-[10px] text-muted-foreground">Evidence: {insight.evidence_document_ids.length} notes</p>
              <div className="mt-3 flex gap-2"><Button size="sm" className="h-7 flex-1 text-xs" onClick={() => void reviewInsight(insight.id, "confirmed")}><Check className="mr-1 h-3 w-3" />Confirm</Button><Button size="sm" variant="outline" className="h-7 flex-1 text-xs" onClick={() => void reviewInsight(insight.id, "rejected")}><X className="mr-1 h-3 w-3" />Reject</Button></div>
            </div>
          ))}
        </div>
        <div className="mt-5 border-t pt-4"><p className="text-xs font-medium">Confirmed memories</p><p className="mt-1 text-2xl font-semibold">{insights.filter((item) => item.status === "confirmed").length}</p><p className="text-[11px] text-muted-foreground">Only these are included as long-term personal context.</p></div>
      </aside>
      </div>
    </div>
  );
}
