"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

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
interface LayoutNode extends GraphNode { x: number; y: number; rank: number }

const COLORS: Record<string, string> = {
  "Business": "#f97316",
  "Product": "#2563eb",
  "Operations": "#7c3aed",
  "Marketing": "#db2777",
  "Thinking": "#059669",
  "Life": "#d97706",
  "Technology": "#0891b2",
  "Learning": "#4f46e5",
  "Writing": "#dc2626",
  "Notes": "#65a30d",
};

const GROUP_LABELS: Record<string, string> = {
  "商业": "Business",
  "产品": "Product",
  "运营": "Operations",
  "营销": "Marketing",
  "思考": "Thinking",
  "生活": "Life",
  "技术": "Technology",
  "学习": "Learning",
  "创作": "Writing",
  "随笔": "Notes",
};

const WIDTH = 1180;
const HEIGHT = 680;

function englishGroup(group: string) {
  return GROUP_LABELS[group] || group || "Other";
}

function nodeColor(group: string) {
  return COLORS[englishGroup(group)] || "#64748b";
}

function trimLabel(label: string, max = 24) {
  return label.length > max ? `${label.slice(0, max - 1)}...` : label;
}

function stableJitter(id: string) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

export default function GraphPage() {
  const router = useRouter();
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [minSimilarity, setMinSimilarity] = useState(0.5);
  const [showIsolated, setShowIsolated] = useState(false);
  const [query, setQuery] = useState("");

  const fetchData = useCallback(async (threshold: number) => {
    setLoading(true);
    setError("");
    try {
      const graph = await apiFetch<GraphData>(
        `/graph/full?limit=160&neighbors=4&min_similarity=${threshold}&max_edges=260`,
      );
      setData(graph);
      setSelectedId(null);
      setFocusNodeId(null);
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

  const groups = useMemo(() => Object.keys(data?.stats.groups || {}).sort(), [data]);

  const visibleData = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], edges: [] as GraphEdge[] };
    let allowed = new Set(data.nodes
      .filter((node) => (showIsolated || node.degree > 0) && (!filterGroup || node.group === filterGroup))
      .map((node) => node.id));
    if (focusNodeId) {
      const local = new Set<string>([focusNodeId]);
      data.edges.forEach((edge) => {
        if (edge.source === focusNodeId) local.add(edge.target);
        if (edge.target === focusNodeId) local.add(edge.source);
      });
      allowed = new Set([...allowed].filter((id) => local.has(id)));
    }
    return {
      nodes: data.nodes.filter((node) => allowed.has(node.id)),
      edges: data.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
    };
  }, [data, filterGroup, focusNodeId, showIsolated]);

  const layout = useMemo(() => {
    const byGroup = new Map<string, GraphNode[]>();
    visibleData.nodes.forEach((node) => {
      const key = englishGroup(node.group);
      const bucket = byGroup.get(key) || [];
      bucket.push(node);
      byGroup.set(key, bucket);
    });

    const groupNames = [...byGroup.keys()].sort();
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(groupNames.length || 1))));
    const rows = Math.max(1, Math.ceil((groupNames.length || 1) / cols));
    const nodes: LayoutNode[] = [];
    const centers = new Map<string, { x: number; y: number }>();

    groupNames.forEach((group, groupIndex) => {
      const col = groupIndex % cols;
      const row = Math.floor(groupIndex / cols);
      const center = {
        x: 120 + col * ((WIDTH - 240) / Math.max(cols - 1, 1)),
        y: 110 + row * ((HEIGHT - 220) / Math.max(rows - 1, 1)),
      };
      centers.set(group, center);

      const groupNodes = (byGroup.get(group) || []).sort((a, b) => b.degree - a.degree || b.size - a.size);
      const maxRadius = Math.min(130, 50 + groupNodes.length * 2.4);
      groupNodes.forEach((node, index) => {
        const angle = index * 2.399963 + stableJitter(node.id) * 0.35;
        const radius = index === 0 ? 0 : Math.min(maxRadius, 28 + Math.sqrt(index) * 18);
        nodes.push({
          ...node,
          rank: index,
          x: Math.max(24, Math.min(WIDTH - 24, center.x + Math.cos(angle) * radius)),
          y: Math.max(24, Math.min(HEIGHT - 24, center.y + Math.sin(angle) * radius)),
        });
      });
    });

    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    return { nodes, nodeMap, centers };
  }, [visibleData.nodes]);

  const selected = selectedId ? layout.nodeMap.get(selectedId) || null : null;
  const hovered = hoveredId ? layout.nodeMap.get(hoveredId) || null : null;
  const connected = selected
    ? visibleData.edges
        .filter((edge) => edge.source === selected.id || edge.target === selected.id)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12)
    : [];
  const connectedIds = new Set(connected.flatMap((edge) => [edge.source, edge.target]));
  const searchResults = query.trim() && data
    ? data.nodes.filter((node) => node.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 7)
    : [];
  const labelIds = new Set(layout.nodes.filter((node) => node.rank < 2 || node.degree >= 6).map((node) => node.id));
  if (selected) labelIds.add(selected.id);
  if (hovered) labelIds.add(hovered.id);

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

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setFilterGroup(null)} className={`rounded px-3 py-1 text-xs ${!filterGroup ? "bg-blue-600 text-white" : "bg-card text-muted-foreground"}`}>All</button>
        {groups.map((group) => (
          <button key={group} onClick={() => setFilterGroup(filterGroup === group ? null : group)}
            className="rounded border px-3 py-1 text-xs" style={{ borderColor: `${nodeColor(group)}66`, color: nodeColor(group) }}>
            {englishGroup(group)} {data?.stats.groups[group] || 0}
          </button>
        ))}
        {focusNodeId && <button onClick={() => setFocusNodeId(null)} className="rounded bg-amber-500/15 px-3 py-1 text-xs text-amber-700">Exit local map</button>}
        <button onClick={() => setShowIsolated((value) => !value)} className={`rounded border px-3 py-1 text-xs ${showIsolated ? "border-blue-400 bg-blue-500/15 text-blue-700" : "border-border bg-card text-muted-foreground"}`}>
          {showIsolated ? "Hide isolated" : `Show isolated ${data?.stats.isolated_count || 0}`}
        </button>
        <div className="relative ml-auto min-w-56">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a node..."
            className="w-full rounded border border-border bg-card px-3 py-1.5 text-xs outline-none focus:border-blue-500" />
          {searchResults.length > 0 && (
            <div className="absolute right-0 top-full z-20 mt-1 w-full rounded border border-border bg-popover p-1 shadow-xl">
              {searchResults.map((node) => <button key={node.id} onClick={() => { setSelectedId(node.id); setFocusNodeId(node.id); setQuery(""); }}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent">{node.label}</button>)}
            </div>
          )}
        </div>
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
            {[...layout.centers.entries()].map(([group, center]) => (
              <g key={group}>
                <circle cx={center.x} cy={center.y} r="150" fill={COLORS[group] || "#64748b"} opacity="0.055" />
                <text x={center.x - 138} y={center.y - 128} fill="#64748b" fontSize="13" fontWeight="600">{group}</text>
              </g>
            ))}
            {visibleData.edges.map((edge) => {
              const source = layout.nodeMap.get(edge.source);
              const target = layout.nodeMap.get(edge.target);
              if (!source || !target) return null;
              const active = selected ? edge.source === selected.id || edge.target === selected.id : false;
              return (
                <line key={`${edge.source}:${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y}
                  stroke={active ? "#2563eb" : "#94a3b8"} strokeWidth={active ? 2.2 : Math.max(0.7, edge.weight * 1.8)}
                  strokeOpacity={active ? 0.65 : 0.2} />
              );
            })}
            {layout.nodes.map((node) => {
              const active = selected?.id === node.id;
              const connectedToSelected = selected ? connectedIds.has(node.id) : false;
              const radius = Math.max(5, Math.min(17, 5 + node.degree * 0.9 + node.size * 0.12));
              const muted = selected && !active && !connectedToSelected;
              return (
                <g key={node.id} onMouseEnter={() => setHoveredId(node.id)} onMouseLeave={() => setHoveredId(null)}
                  onClick={() => setSelectedId(node.id)} onDoubleClick={() => router.push(`/documents/${node.document_id}`)}
                  className="cursor-pointer">
                  <circle cx={node.x} cy={node.y} r={radius + (active ? 7 : 3)} fill="white" opacity={muted ? 0.45 : 1} />
                  <circle cx={node.x} cy={node.y} r={radius} fill={nodeColor(node.group)} opacity={muted ? 0.28 : 0.9} filter={active ? "url(#softShadow)" : undefined} />
                  {active && <circle cx={node.x} cy={node.y} r={radius + 7} fill="none" stroke="#2563eb" strokeWidth="2.5" />}
                  {labelIds.has(node.id) && (
                    <text x={node.x + radius + 7} y={node.y + 4} fill="#0f172a" fontSize="12" fontWeight={active ? 700 : 500}
                      paintOrder="stroke" stroke="#f8fafc" strokeWidth="4">
                      {trimLabel(node.label)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="absolute bottom-3 left-3 rounded bg-white/85 px-2 py-1 text-[11px] text-slate-500 shadow-sm">
            Click for details · Double-click to open document · Labels appear only on important or focused nodes
          </div>
        </div>

        <aside className="rounded-lg border border-border bg-card p-4">
          {selected ? (
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: nodeColor(selected.group) }} />
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{englishGroup(selected.group)}</span>
                </div>
                <h2 className="mt-2 text-lg font-semibold leading-tight">{selected.label}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{selected.degree} links · document #{selected.document_id}</p>
              </div>
              {selected.snippet && <p className="text-sm leading-relaxed text-muted-foreground">{selected.snippet}</p>}
              <div className="flex gap-2">
                <button onClick={() => setFocusNodeId(selected.id)} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent">Local map</button>
                <button onClick={() => router.push(`/documents/${selected.document_id}`)} className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white">Open document</button>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strongest links</h3>
                <div className="space-y-1.5">
                  {connected.length === 0 && <p className="text-xs text-muted-foreground">No visible links for this filter.</p>}
                  {connected.map((edge) => {
                    const otherId = edge.source === selected.id ? edge.target : edge.source;
                    const node = layout.nodeMap.get(otherId);
                    return node ? (
                      <button key={`${edge.source}:${edge.target}`} onClick={() => setSelectedId(node.id)}
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
    </div>
  );
}
