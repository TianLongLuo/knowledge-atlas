const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: "include",
  });
  if (response.status === 401) {
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.assign("/login");
    }
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(payload.detail || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface LoginRequest { username: string; password: string }
export interface LoginResponse { access_token: string; token_type: string }

export function login(data: LoginRequest) {
  return apiFetch<LoginResponse>("/auth/login", { method: "POST", body: JSON.stringify(data) });
}
export function logout() { return apiFetch<void>("/auth/logout", { method: "POST" }); }
export function checkSession() { return apiFetch<{ username: string }>("/auth/me"); }

export interface DashboardStats {
  total_documents: number;
  total_chunks: number;
  last_sync_time: string | null;
  sync_status: string;
}
export interface RecentDocument { id: string; title: string; source_type: string; created_at: string }
export function getDashboardStats() { return apiFetch<DashboardStats>("/dashboard/stats"); }
export function getRecentDocuments() { return apiFetch<RecentDocument[]>("/dashboard/recent"); }

interface RawDocument {
  id: number;
  source_type: string;
  source_id?: string | null;
  title: string;
  raw_content?: string | null;
  normalized_content?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  chunks?: ChunkItem[];
  nodes?: KnowledgeNode[];
  edges?: KnowledgeEdge[];
}

export interface DocumentItem {
  id: string;
  title: string;
  source_type: string;
  file_type: string;
  file_size: number;
  created_at: string;
  updated_at: string;
  status: string;
  chunk_count: number;
  tags: string[];
  note_at: string;
  category: string;
  content: string;
}
export interface DocumentListResponse { items: DocumentItem[]; total: number; page: number; page_size: number }
export interface ChunkItem { id: number; document_id: number; chunk_index: number; chunk_text: string; token_count: number }
export interface KnowledgeNode { node_id: string; title: string; node_type: string; importance_score: number }
export interface KnowledgeEdge { id: number; source_node_id: string; target_node_id: string; relation_type: string; confidence: number }
export interface DocumentDetail extends DocumentItem {
  content: string;
  metadata: Record<string, unknown>;
  chunks: ChunkItem[];
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

function mapDocument(doc: RawDocument): DocumentItem {
  const content = doc.normalized_content || doc.raw_content || "";
  const rawTags = doc.metadata?.tags || doc.metadata?.tag || [];
  const tags = Array.isArray(rawTags)
    ? rawTags.map(String).filter(Boolean)
    : String(rawTags).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
  const noteAt = ["note_created_at", "original_created_at", "created_time", "published_at", "note_date", "date", "timestamp"]
    .map((key) => doc.metadata?.[key])
    .find(Boolean);
  return {
    id: String(doc.id),
    title: doc.title,
    source_type: doc.source_type,
    file_type: String(doc.metadata?.file_type || doc.source_type),
    file_size: new TextEncoder().encode(content).length,
    created_at: doc.created_at || doc.updated_at || new Date(0).toISOString(),
    updated_at: doc.updated_at || doc.created_at || new Date(0).toISOString(),
    status: "ready",
    chunk_count: doc.chunks?.length || 0,
    tags,
    note_at: String(noteAt || doc.created_at || doc.updated_at || new Date(0).toISOString()),
    category: String(doc.metadata?._category || doc.metadata?.category || doc.metadata?.group || "Uncategorized"),
    content,
  };
}

export async function getDocuments(params: {
  page?: number; page_size?: number; search?: string; source_type?: string; date_from?: string; date_to?: string;
  date_field?: "note_date" | "system_created"; tag?: string;
  category?: string;
  sort_by?: "note_date" | "system_created" | "updated_at" | "title"; sort_order?: "asc" | "desc";
}): Promise<DocumentListResponse> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== "") query.set(key, String(value)); });
  const raw = await apiFetch<{ items: RawDocument[]; total: number; page: number; page_size: number }>(`/documents?${query}`);
  return { ...raw, items: raw.items.map(mapDocument) };
}

export function getDocumentFilterOptions() {
  return apiFetch<{ categories: Array<{ name: string; tags: string[] }> }>("/documents/filter-options");
}

export async function getDocument(id: string): Promise<DocumentDetail> {
  const doc = await apiFetch<RawDocument>(`/documents/${encodeURIComponent(id)}`);
  const base = mapDocument(doc);
  return {
    ...base,
    content: doc.normalized_content || doc.raw_content || "",
    metadata: doc.metadata || {},
    chunks: doc.chunks || [],
    nodes: doc.nodes || [],
    edges: doc.edges || [],
    chunk_count: doc.chunks?.length || 0,
  };
}
export function updateDocument(id: string, data: { title?: string; content?: string; tags?: string; category?: string }) {
  return apiFetch<RawDocument>(`/documents/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) });
}
export function deleteDocument(id: string) {
  return apiFetch<{ message: string; id: number }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function createNote(data: { title: string; content: string; source?: string; tags?: string; category?: string }) {
  return apiFetch<{
    id: string;
    title: string;
    notion_sync?: { status: "completed" | "failed" | "not_configured"; notion_page_id?: string; error?: string } | null;
  }>("/notes", { method: "POST", body: JSON.stringify(data) });
}

export interface SearchResultItem {
  document_id: string;
  document_title: string;
  chunk_id: string | null;
  content: string;
  score: number;
  source_type: string;
}
export interface SearchResponse { results: SearchResultItem[]; total: number; query: string; search_type: string }
export async function search(params: { query: string; search_type?: string; top_k?: number }): Promise<SearchResponse> {
  const query = new URLSearchParams({ q: params.query, type: params.search_type || "hybrid" });
  if (params.top_k) query.set("top_k", String(params.top_k));
  const raw = await apiFetch<{ query: string; total: number; results: Array<{
    title: string; snippet: string; source_type?: string | null; similarity_score: number; document_id: number; chunk_id?: string | null;
  }> }>(`/search?${query}`);
  return {
    query: raw.query,
    total: raw.total,
    search_type: params.search_type || "hybrid",
    results: raw.results.map((item) => ({
      document_id: String(item.document_id), document_title: item.title, chunk_id: item.chunk_id || null,
      content: item.snippet, score: item.similarity_score, source_type: item.source_type || "unknown",
    })),
  };
}

export interface AgentRequest { question: string; session_id?: string; document_id?: string; top_k?: number; mode?: "knowledge" | "reflection" | "socratic" }
export interface AgentCitation {
  document_id: string; document_title: string; content: string; relevance_score: number; source_url?: string | null;
}
export interface AgentResponse { question: string; answer: string; citations: AgentCitation[]; session_id: string }
export interface AgentStatus {
  deepseek_configured: boolean;
  deepseek_available: boolean;
  deepseek_error?: string | null;
  vector_store_available: boolean;
  vector_document_count: number;
  model: string;
}
export function getAgentStatus() { return apiFetch<AgentStatus>("/agent/status"); }
export interface MemoryLevelStatus { level: string; title: string; count: number; description: string }
export interface AgentMemoryStatus { session_id?: string | null; vector_count: number; levels: MemoryLevelStatus[] }
export interface MemoryInsight { id: string; statement: string; insight_type: string; confidence: number; status: "pending" | "confirmed" | "rejected"; evidence_document_ids: number[]; created_at?: string | null }
export function getAgentMemoryStatus(sessionId?: string) {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  return apiFetch<AgentMemoryStatus>(`/agent/memory/status${query}`);
}
export function getMemoryInsights(status?: string) {
  return apiFetch<MemoryInsight[]>(`/agent/memory/insights${status ? `?status=${encodeURIComponent(status)}` : ""}`);
}
export function reviewMemoryInsight(id: string, status: "confirmed" | "rejected") {
  return apiFetch<MemoryInsight>(`/agent/memory/insights/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ status }) });
}
export async function askAgent(data: AgentRequest): Promise<AgentResponse> {
  const raw = await apiFetch<{ question: string; answer: string; session_id: string; citations: Array<{
    document_id: number; document_title: string; chunk_snippet: string; similarity_score: number; source_url?: string | null;
  }> }>("/agent/ask", {
    method: "POST",
    body: JSON.stringify({ ...data, document_id: data.document_id ? Number(data.document_id) : undefined }),
  });
  return { ...raw, citations: raw.citations.map((citation) => ({
    document_id: String(citation.document_id), document_title: citation.document_title,
    content: citation.chunk_snippet, relevance_score: citation.similarity_score, source_url: citation.source_url,
  })) };
}

export interface WritingIssue { excerpt: string; issue: string; suggestion: string }
export interface WritingReference { document_id: number; title: string; connection: string; relevance: number }
export interface WritingAssistResponse {
  suggested_titles: string[];
  directions: string[];
  logic_issues: WritingIssue[];
  grammar_issues: WritingIssue[];
  historical_references: WritingReference[];
}
export function getWritingAssistance(data: { title: string; content: string; document_id?: number }) {
  return apiFetch<WritingAssistResponse>("/agent/writing-assist", {
    method: "POST",
    body: JSON.stringify({ ...data, allow_external_processing: true }),
  });
}
export function suggestDocumentTags(data: { title: string; content: string }) {
  return apiFetch<{ tags: string[] }>("/agent/suggest-tags", {
    method: "POST",
    body: JSON.stringify({ ...data, allow_external_processing: true }),
  });
}

interface RawSyncState { source_type: string; source_id: string; status: string; last_synced_at: string | null; error_message: string | null }
export interface SyncStatus { status: string; last_sync_time: string | null; sync_in_progress: boolean; total_synced: number; errors: number }
export interface SyncHistoryItem { id: string; started_at: string; completed_at: string | null; status: string; documents_processed: number; errors: number }
export async function getSyncStatus(): Promise<SyncStatus> {
  const states = await apiFetch<RawSyncState[]>("/sync/status");
  const latest = states[0];
  return {
    status: latest?.status === "running" ? "syncing" : latest?.status === "failed" ? "error" : "idle",
    last_sync_time: latest?.last_synced_at || null,
    sync_in_progress: latest?.status === "running",
    total_synced: states.filter((state) => state.status === "completed").length,
    errors: states.filter((state) => state.status === "failed").length,
  };
}
export async function getSyncHistory(): Promise<SyncHistoryItem[]> {
  const states = await apiFetch<RawSyncState[]>("/sync/status");
  return states.map((state, index) => ({
    id: `${state.source_id}-${index}`,
    started_at: state.last_synced_at || new Date(0).toISOString(),
    completed_at: state.last_synced_at,
    status: state.status,
    documents_processed: state.status === "completed" ? 1 : 0,
    errors: state.status === "failed" ? 1 : 0,
  }));
}
export function startSync() {
  return apiFetch<{ message: string; source_type: string; status: string }>("/sync/notion/start", { method: "POST" });
}
