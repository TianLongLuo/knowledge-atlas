"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, getDocument } from "@/lib/api";
import type { DocumentDetail } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface GraphNode {
  id: string;
  label: string;
  group: string;
  size: number;
  snippet: string;
  document_id: number;
  source: string;
  degree: number;
}
interface GraphEdge { source: string; target: string; weight: number; label: string; edge_type: string }
interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { node_count: number; edge_count: number; isolated_count: number; groups: Record<string, number> };
}
interface LayoutNode extends GraphNode { x: number; y: number }

const WIDTH = 1180;
const HEIGHT = 680;
const TYPE_COLORS = ["#7c3aed", "#2563eb", "#db2777", "#059669", "#d97706", "#0891b2"];

function stableJitter(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

function nodeType(node: GraphNode) {
  return node.source || "note";
}

export default function GraphPage() {
  const router = useRouter();
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [minSimilarity, setMinSimilarity] = useState(0.5);
  const [query, setQuery] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerDocument, setReaderDocument] = useState<DocumentDetail | null>(null);
  const [readerError, setReaderError] = useState("");

  const openReader = useCallback(async (node: GraphNode) => {
    setSelectedId(node.id);
    setReaderOpen(true);
    setReaderLoading(true);
    setReaderError("");
    setReaderDocument(null);
    try {
      setReaderDocument(await getDocument(String(node.document_id)));
    } catch (cause) {
      setReaderError(cause instanceof Error ? cause.message : "Document failed to load.");
    } finally {
      setReaderLoading(false);
    }
  }, []);

  const fetchData = useCallback(async (threshold: number) => {
    setLoading(true);
    setError("");
    try {
      const graph = await apiFetch<GraphData>(
        `/graph/full?limit=160&neighbors=4&min_similarity=${threshold}&max_edges=260`,
      );
      setData(graph);
      setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Knowledge map failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(0.5); }, [fetchData]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchData(minSimilarity); }, 350);
    return () => window.clearTimeout(timer);
  }, [minSimilarity, fetchData]);

  const visibleData = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    const allowed = new Set(data.nodes
      .filter((node) => node.degree > 0 && !hiddenTypes.has(nodeType(node)))
      .map((node) => node.id));
    return {
      nodes: data.nodes.filter((node) => allowed.has(node.id)),
      edges: data.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
    };
  }, [data, hiddenTypes]);

  const typeStats = useMemo(() => {
    const counts = new Map<string, number>();
    data?.nodes.forEach((node) => counts.set(nodeType(node), (counts.get(nodeType(node)) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);
  const typeColor = (type: string) => TYPE_COLORS[Math.max(0, typeStats.findIndex(([name]) => name === type)) % TYPE_COLORS.length];

  const layout = useMemo(() => {
    const sorted = [...visibleData.nodes].sort((a, b) => b.degree - a.degree || b.size - a.size);
    const nodes: LayoutNode[] = sorted.map((node, index) => {
      const angle = index * 2.399963 + stableJitter(node.id) * 0.45;
      const radius = 35 + Math.sqrt(index) * 38;
      return {
        ...node,
        x: WIDTH / 2 + Math.cos(angle) * radius * 1.35,
        y: HEIGHT / 2 + Math.sin(angle) * radius,
      };
    });
    const indexById = new Map(nodes.map((node, index) => [node.id, index]));
    for (let iteration = 0; iteration < 90; iteration += 1) {
      const force = nodes.map(() => ({ x: 0, y: 0 }));
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const dx = nodes[j].x - nodes[i].x || 0.01;
          const dy = nodes[j].y - nodes[i].y || 0.01;
          const distance2 = Math.max(100, dx * dx + dy * dy);
          const strength = 1900 / distance2;
          force[i].x -= dx * strength; force[i].y -= dy * strength;
          force[j].x += dx * strength; force[j].y += dy * strength;
        }
      }
      visibleData.edges.forEach((edge) => {
        const sourceIndex = indexById.get(edge.source);
        const targetIndex = indexById.get(edge.target);
        if (sourceIndex === undefined || targetIndex === undefined) return;
        const dx = nodes[targetIndex].x - nodes[sourceIndex].x;
        const dy = nodes[targetIndex].y - nodes[sourceIndex].y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const pull = (distance - (125 - edge.weight * 45)) * 0.008;
        force[sourceIndex].x += dx / distance * pull; force[sourceIndex].y += dy / distance * pull;
        force[targetIndex].x -= dx / distance * pull; force[targetIndex].y -= dy / distance * pull;
      });
      const cooling = 1 - iteration / 110;
      nodes.forEach((node, index) => {
        force[index].x += (WIDTH / 2 - node.x) * 0.002;
        force[index].y += (HEIGHT / 2 - node.y) * 0.002;
        node.x = Math.max(24, Math.min(WIDTH - 24, node.x + force[index].x * cooling));
        node.y = Math.max(24, Math.min(HEIGHT - 24, node.y + force[index].y * cooling));
      });
    }
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    return { nodes, nodeMap };
  }, [visibleData.nodes, visibleData.edges]);

  const selected = selectedId ? layout.nodeMap.get(selectedId) || null : null;
  const hovered = hoveredId ? layout.nodeMap.get(hoveredId) || null : null;
  const focused = hovered || selected;
  const connected = focused
    ? visibleData.edges
        .filter((edge) => edge.source === focused.id || edge.target === focused.id)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6)
    : [];
  const connectedIds = new Set(connected.flatMap((edge) => [edge.source, edge.target]));
  const connectedEdgeKeys = new Set(connected.map((edge) => `${edge.source}:${edge.target}`));
  const searchResults = query.trim() && data
    ? data.nodes.filter((node) => node.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 7)
    : [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Knowledge Map</h1>
          <p className="text-sm text-muted-foreground">
            {data?.stats.node_count || 0} nodes · {data?.stats.edge_count || 0} semantic links · {data?.stats.isolated_count || 0} isolated
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            Similarity
            <input type="range" min="0.4" max="0.8" step="0.05" value={minSimilarity}
              onChange={(event) => setMinSimilarity(Number(event.target.value))} className="w-28 accent-blue-600" />
            <span className="w-8 tabular-nums">{minSimilarity.toFixed(2)}</span>
          </label>
          <button onClick={() => void fetchData(minSimilarity)} className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500">Refresh</button>
        </div>
      </div>

      <div className="flex justify-end">
        <div className="relative min-w-72">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node..."
            className="w-full rounded border border-border bg-card px-3 py-1.5 text-xs outline-none focus:border-blue-500" />
          {searchResults.length > 0 && (
            <div className="absolute right-0 top-full z-20 mt-1 w-full rounded border border-border bg-popover p-1 shadow-xl">
              {searchResults.map((node) => <button key={node.id} onClick={() => { setQuery(""); setSelectedId(node.id); }}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent">{node.label}</button>)}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Types · {data?.stats.node_count || 0} total</span>
        {typeStats.map(([type, count]) => {
          const hidden = hiddenTypes.has(type);
          return (
            <button key={type} onClick={() => setHiddenTypes((current) => {
              const next = new Set(current); if (next.has(type)) next.delete(type); else next.add(type); return next;
            })} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${hidden ? "opacity-40" : "bg-card"}`}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: typeColor(type) }} />
              {type} <span className="text-muted-foreground">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="relative overflow-hidden rounded-lg border border-border bg-white">
          {loading && <div className="absolute inset-0 z-10 grid place-items-center bg-white/80 text-sm text-muted-foreground">Building map...</div>}
          {error && <div className="absolute inset-0 z-10 grid place-items-center bg-white/90 text-sm text-red-600">{error}</div>}
          {!loading && !error && visibleData.nodes.length === 0 && <div className="absolute inset-0 z-10 grid place-items-center text-sm text-muted-foreground">No nodes match this filter.</div>}
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block h-[72vh] min-h-[540px] w-full">
            <defs>
              <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#0f172a" floodOpacity="0.12" />
              </filter>
            </defs>
            <rect width={WIDTH} height={HEIGHT} fill="#f8fafc" />
            {visibleData.edges.map((edge) => {
              const source = layout.nodeMap.get(edge.source);
              const target = layout.nodeMap.get(edge.target);
              if (!source || !target) return null;
              const active = connectedEdgeKeys.has(`${edge.source}:${edge.target}`);
              if (focused && !active) return null;
              return (
                <line key={`${edge.source}:${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y}
                  stroke={active ? "#2563eb" : "#94a3b8"} strokeWidth={active ? Math.max(1.2, edge.weight * 2.4) : 0.7} strokeOpacity={active ? 0.65 : 0.12} />
              );
            })}
            {layout.nodes.map((node) => {
              const active = focused?.id === node.id;
              const connectedToSelected = focused ? connectedIds.has(node.id) : false;
              const radius = Math.max(5, Math.min(17, 5 + node.degree * 0.9 + node.size * 0.12));
              const muted = focused && !active && !connectedToSelected;
              return (
                <g key={node.id} onMouseEnter={() => { setHoveredId(node.id); setSelectedId(node.id); }} onMouseLeave={() => setHoveredId(null)}
                  onClick={() => setSelectedId(node.id)}
                  className="cursor-pointer">
                  <circle cx={node.x} cy={node.y} r={radius + (active ? 7 : 3)} fill="white" opacity={muted ? 0.45 : 1} />
                  <circle cx={node.x} cy={node.y} r={radius} fill={active ? "#2563eb" : connectedToSelected ? "#8b5cf6" : typeColor(nodeType(node))} opacity={muted ? 0.2 : 0.88} filter={active ? "url(#softShadow)" : undefined} />
                  {active && <circle cx={node.x} cy={node.y} r={radius + 7} fill="none" stroke="#2563eb" strokeWidth="2.5" />}
                </g>
              );
            })}
          </svg>
          <div className="absolute bottom-3 left-3 rounded bg-white/85 px-2 py-1 text-[11px] text-slate-500 shadow-sm">
            Hover a node to reveal its six strongest links · Click to pin the selection
          </div>
        </div>

        <aside className="rounded-lg border border-border bg-card p-4">
          {focused ? (
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-blue-600" />
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Selected note</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold leading-tight">{focused.label}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{focused.degree} links · document #{focused.document_id}</p>
              </div>
              {focused.snippet && <p className="text-sm leading-relaxed text-muted-foreground">{focused.snippet}</p>}
              <div className="flex gap-2">
                <button onClick={() => void openReader(focused)} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">Read this note</button>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strongest links</h3>
                <div className="space-y-1.5">
                  {connected.length === 0 && <p className="text-xs text-muted-foreground">No visible links for this filter.</p>}
                  {connected.map((edge) => {
                    const otherId = edge.source === focused.id ? edge.target : edge.source;
                    const node = layout.nodeMap.get(otherId);
                    return node ? (
                      <button key={`${edge.source}:${edge.target}`} onClick={() => void openReader(node)}
                        className="flex w-full items-center justify-between gap-3 rounded border border-border bg-background px-2 py-1.5 text-left text-xs hover:bg-accent">
                        <span className="truncate">{node.label}</span>
                        <span className="shrink-0 text-muted-foreground">{(edge.weight * 100).toFixed(0)}%</span>
                      </button>
                    ) : null;
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[260px] flex-col justify-center text-sm text-muted-foreground">
              <h2 className="mb-2 text-base font-semibold text-foreground">Select a node</h2>
              <p>Use the map as an overview, then click a topic to read its context and closest links here.</p>
            </div>
          )}
        </aside>
      </div>

      <Dialog open={readerOpen} onOpenChange={setReaderOpen}>
        <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{readerDocument?.title || selected?.label || "Note"}</DialogTitle>
            <DialogDescription>
              {readerDocument ? `${readerDocument.source_type} · Updated ${new Date(readerDocument.updated_at).toLocaleString("en-US")}` : "Knowledge Atlas note reader"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[68vh] overflow-y-auto rounded-lg border border-border bg-background p-5">
            {readerLoading && <p className="text-sm text-muted-foreground">Loading note...</p>}
            {readerError && <p className="text-sm text-red-600">{readerError}</p>}
            {readerDocument && <article className="whitespace-pre-wrap text-sm leading-7 text-foreground">{readerDocument.content || "This note has no readable content."}</article>}
          </div>
          {readerDocument && (
            <div className="flex justify-end">
              <button onClick={() => router.push(`/documents/${readerDocument.id}`)} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent">Open full document page</button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
