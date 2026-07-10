const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";

// Token management
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("auth_token");
}

export function setToken(token: string): void {
  localStorage.setItem("auth_token", token);
}

export function clearToken(): void {
  localStorage.removeItem("auth_token");
}

async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(errorBody.detail || `Request failed: ${res.status}`);
  }

  return res.json();
}

// --- Auth ---

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
}

export async function login(data: LoginRequest): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ detail: "登录失败" }));
    throw new Error(errorBody.detail || "登录失败");
  }

  const result: LoginResponse = await res.json();
  setToken(result.access_token);
  return result;
}

// --- Dashboard ---

export interface DashboardStats {
  total_documents: number;
  total_chunks: number;
  last_sync_time: string | null;
  sync_status: string;
}

export interface RecentDocument {
  id: string;
  title: string;
  source_type: string;
  created_at: string;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return apiFetch<DashboardStats>("/dashboard/stats");
}

export async function getRecentDocuments(): Promise<RecentDocument[]> {
  return apiFetch<RecentDocument[]>("/dashboard/recent");
}

// --- Documents ---

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
}

export interface DocumentListResponse {
  items: DocumentItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface DocumentDetail {
  id: string;
  title: string;
  content: string;
  source_type: string;
  file_type: string;
  file_size: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  status: string;
}

export interface ChunkItem {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  metadata: Record<string, unknown>;
}

export interface KnowledgeNode {
  id: string;
  label: string;
  node_type: string;
  properties: Record<string, unknown>;
}

export interface KnowledgeEdge {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  properties: Record<string, unknown>;
}

export interface DocumentRelations {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export async function getDocuments(params: {
  page?: number;
  page_size?: number;
  search?: string;
  source_type?: string;
  date_from?: string;
  date_to?: string;
}): Promise<DocumentListResponse> {
  const searchParams = new URLSearchParams();
  if (params.page) searchParams.set("page", params.page.toString());
  if (params.page_size) searchParams.set("page_size", params.page_size.toString());
  if (params.search) searchParams.set("search", params.search);
  if (params.source_type) searchParams.set("source_type", params.source_type);
  if (params.date_from) searchParams.set("date_from", params.date_from);
  if (params.date_to) searchParams.set("date_to", params.date_to);

  return apiFetch<DocumentListResponse>(`/documents?${searchParams.toString()}`);
}

export async function getDocument(id: string): Promise<DocumentDetail> {
  return apiFetch<DocumentDetail>(`/documents/${id}`);
}

export async function getDocumentChunks(id: string): Promise<ChunkItem[]> {
  return apiFetch<ChunkItem[]>(`/documents/${id}/chunks`);
}

export async function getDocumentRelations(id: string): Promise<DocumentRelations> {
  return apiFetch<DocumentRelations>(`/documents/${id}/relations`);
}

export async function updateDocument(
  id: string,
  data: { title?: string; content?: string }
): Promise<DocumentDetail> {
  return apiFetch<DocumentDetail>(`/documents/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteDocument(id: string): Promise<{ message: string; id: string }> {
  return apiFetch<{ message: string; id: string }>(`/documents/${id}`, {
    method: "DELETE",
  });
}

// --- Search ---

export interface SearchRequest {
  query: string;
  search_type: "keyword" | "vector" | "hybrid";
  top_k?: number;
}

export interface SearchResultItem {
  document_id: string;
  document_title: string;
  chunk_id: string;
  content: string;
  score: number;
  source_type: string;
  metadata: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  query: string;
  search_type: string;
}

export async function search(params: {
  query: string;
  search_type?: string;
  top_k?: number;
}): Promise<SearchResponse> {
  const sp = new URLSearchParams();
  sp.set("q", params.query);
  sp.set("type", params.search_type || "hybrid");
  if (params.top_k) sp.set("top_k", params.top_k.toString());
  return apiFetch<SearchResponse>(`/search?${sp.toString()}`);
}

// --- AI Agent ---

export interface AgentRequest {
  question: string;
  session_id?: string;
  document_id?: string;
}

export interface AgentCitation {
  document_id: string;
  document_title: string;
  chunk_id: string;
  content: string;
  relevance_score: number;
}

export interface AgentResponse {
  answer: string;
  citations: AgentCitation[];
  session_id: string;
}

export async function askAgent(data: AgentRequest): Promise<AgentResponse> {
  return apiFetch<AgentResponse>("/agent/ask", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export interface AgentHistoryItem {
  question: string;
  answer: string;
  citations: AgentCitation[];
  timestamp: string;
}

export async function getAgentHistory(session_id: string): Promise<AgentHistoryItem[]> {
  return apiFetch<AgentHistoryItem[]>(`/agent/history/${session_id}`);
}

// --- Sync ---

export interface SyncStatus {
  status: string;
  last_sync_time: string | null;
  sync_in_progress: boolean;
  total_synced: number;
  errors: number;
}

export interface SyncHistoryItem {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  documents_processed: number;
  errors: number;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  return apiFetch<SyncStatus>("/sync/status");
}

export async function startSync(): Promise<{ message: string; sync_id: string }> {
  return apiFetch<{ message: string; sync_id: string }>("/sync/start", {
    method: "POST",
  });
}

export async function getSyncHistory(): Promise<SyncHistoryItem[]> {
  return apiFetch<SyncHistoryItem[]>("/sync/history");
}
