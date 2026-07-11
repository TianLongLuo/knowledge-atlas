"use client";

import { useState, useRef, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { askAgent, getAgentStatus, AgentResponse, AgentCitation, AgentStatus } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, User, Send, Loader2, FileText, ExternalLink } from "lucide-react";

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
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // If coming from document detail, pre-fill with context
  useEffect(() => {
    if (docId) {
      setInput(`Analyze this document (${docId})`);
    }
  }, [docId]);

  useEffect(() => {
    void getAgentStatus().then(setStatus).catch(() => setStatus(null));
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
      });

      if (!sessionId) {
        setSessionId(response.session_id);
      }

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="max-w-4xl mx-auto h-[calc(100vh-6rem)] flex flex-col">
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
      </div>

      {/* Chat area */}
      <Card className="flex-1 flex flex-col min-h-0">
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
    </div>
  );
}
