"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { ForceGraphMethods, LinkObject, NodeObject } from "react-force-graph-2d";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, ChevronDown, Filter, Focus, Maximize2, RotateCcw, Search, Settings2, X } from "lucide-react";
import { useNoteReader } from "@/components/note-reader";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false }) as typeof import("react-force-graph-2d").default;

interface GraphNode extends NodeObject {
  id: string;
  label: string;
  group: string;
  size: number;
  snippet: string;
  document_id: number;
  source: string;
  node_type: string;
  tags: string[];
  degree: number;
}

interface GraphEdge extends LinkObject<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  weight: number;
  label: string;
  edge_type: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    isolated_count: number;
    groups: Record<string, number>;
    types: Record<string, number>;
    tags: Record<string, number>;
  };
}

const COLORS = ["#8b5cf6", "#3b82f6", "#ec4899", "#10b981", "#f59e0b", "#06b6d4", "#f97316"];

function endpointId(endpoint: string | GraphNode | number | undefined) {
  if (typeof endpoint === "object" && endpoint !== null) return String(endpoint.id);
  return String(endpoint ?? "");
}

function truncate(value: string, length = 34) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export default function GraphPage() {
  const { openDocument } = useNoteReader();
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphEdge> | undefined>(undefined);
  const hasFitRef = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 680 });
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [hiddenTags, setHiddenTags] = useState<Set<string>>(new Set());
  const [showIsolated, setShowIsolated] = useState(false);
  const [localDepth, setLocalDepth] = useState(0);
  const [similarity, setSimilarity] = useState(0.46);
  const [repulsion, setRepulsion] = useState(-125);
  const [linkDistance, setLinkDistance] = useState(75);
  const [showControls, setShowControls] = useState(true);
  const prefersReducedMotion = useRef(false);

  useEffect(() => {
    prefersReducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const fetchGraph = useCallback(async (threshold: number) => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch<GraphData>(
        `/graph/full?limit=220&neighbors=7&min_similarity=${threshold}&max_edges=700`,
      );
      setData(response);
      hasFitRef.current = false;
      setSelectedId(null);
      setLocalDepth(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Knowledge graph failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchGraph(0.46); }, [fetchGraph]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.max(480, entry.contentRect.width), height: Math.max(560, entry.contentRect.height) });
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const charge = graphRef.current?.d3Force("charge") as { strength?: (value: number) => unknown } | undefined;
    const link = graphRef.current?.d3Force("link") as { distance?: (value: number) => unknown } | undefined;
    charge?.strength?.(repulsion);
    link?.distance?.(linkDistance);
    graphRef.current?.d3ReheatSimulation();
  }, [repulsion, linkDistance, data]);

  const typeEntries = useMemo(() => Object.entries(data?.stats.types || {}).sort((a, b) => b[1] - a[1]), [data]);
  const tagEntries = useMemo(() => Object.entries(data?.stats.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 18), [data]);
  const typeColor = useCallback((type: string) => {
    const index = Math.max(0, typeEntries.findIndex(([name]) => name === type));
    return COLORS[index % COLORS.length];
  }, [typeEntries]);

  const localRoot = localDepth > 0 ? selectedId : null;
  const filtered = useMemo(() => {
    if (!data) return { nodes: [] as GraphNode[], links: [] as GraphEdge[] };
    const allowed = new Set(data.nodes.filter((node) => {
      if (!showIsolated && node.degree === 0) return false;
      if (hiddenTypes.has(node.node_type)) return false;
      if (node.tags.some((tag) => hiddenTags.has(tag))) return false;
      return true;
    }).map((node) => node.id));

    if (localDepth > 0 && localRoot && allowed.has(localRoot)) {
      let frontier = new Set([localRoot]);
      const local = new Set([localRoot]);
      for (let depth = 0; depth < localDepth; depth += 1) {
        const next = new Set<string>();
        data.edges.forEach((edge) => {
          const source = endpointId(edge.source);
          const target = endpointId(edge.target);
          if (frontier.has(source) && allowed.has(target)) next.add(target);
          if (frontier.has(target) && allowed.has(source)) next.add(source);
        });
        next.forEach((id) => local.add(id));
        frontier = next;
      }
      [...allowed].forEach((id) => { if (!local.has(id)) allowed.delete(id); });
    }

    return {
      nodes: data.nodes.filter((node) => allowed.has(node.id)).map((node) => ({ ...node })),
      links: data.edges.filter((edge) => allowed.has(endpointId(edge.source)) && allowed.has(endpointId(edge.target)))
        .map((edge) => ({ ...edge, source: endpointId(edge.source), target: endpointId(edge.target) })),
    };
  }, [data, hiddenTypes, hiddenTags, showIsolated, localDepth, localRoot]);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    filtered.links.forEach((edge) => {
      const source = endpointId(edge.source); const target = endpointId(edge.target);
      if (!map.has(source)) map.set(source, new Set());
      if (!map.has(target)) map.set(target, new Set());
      map.get(source)?.add(target); map.get(target)?.add(source);
    });
    return map;
  }, [filtered.links]);

  const focusedId = hoveredId || selectedId;
  const focusedNode = data?.nodes.find((node) => node.id === focusedId) || null;
  const connectedIds = focusedId ? adjacency.get(focusedId) || new Set<string>() : new Set<string>();
  const related = focusedNode && data ? data.edges
    .filter((edge) => endpointId(edge.source) === focusedNode.id || endpointId(edge.target) === focusedNode.id)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
    .map((edge) => ({
      edge,
      node: data.nodes.find((node) => node.id === (endpointId(edge.source) === focusedNode.id ? endpointId(edge.target) : endpointId(edge.source))),
    })).filter((item): item is { edge: GraphEdge; node: GraphNode } => Boolean(item.node)) : [];

  const searchResults = query.trim() && data ? data.nodes.filter((node) =>
    node.label.toLowerCase().includes(query.trim().toLowerCase()),
  ).slice(0, 8) : [];

  const openReader = useCallback((node: GraphNode) => {
    setSelectedId(node.id);
    openDocument(node.document_id);
  }, [openDocument]);

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) => {
    setter((current) => { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; });
  };

  return (
    <div className="flex h-[calc(100vh-3rem)] min-h-[680px] flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Knowledge Graph</h1>
          <p className="text-sm text-muted-foreground">
            {data?.stats.node_count || 0} notes · {data?.stats.edge_count || 0} meaning + category + tag links · {typeEntries.length} types
          </p>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes…" className="pl-9" />
          {searchResults.length > 0 && (
            <div className="absolute right-0 top-full z-30 mt-1 w-full rounded-lg border bg-popover p-1 shadow-xl">
              {searchResults.map((node) => (
                <button key={node.id} onClick={() => { setSelectedId(node.id); setQuery(""); setLocalDepth(1); }} className="block w-full truncate rounded px-3 py-2 text-left text-xs hover:bg-accent">
                  {node.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-blue-100/80 bg-[radial-gradient(circle_at_12%_8%,rgba(255,226,154,0.28),transparent_28%),radial-gradient(circle_at_88%_12%,rgba(250,190,216,0.28),transparent_30%),radial-gradient(circle_at_52%_88%,rgba(164,210,255,0.30),transparent_36%),#fbfcff] shadow-[0_18px_60px_rgba(70,100,160,0.12)]">
        <div ref={canvasRef} className="absolute inset-0">
          {loading && <div className="absolute inset-0 z-20 grid place-items-center bg-white/80 text-sm text-slate-500 backdrop-blur-sm">Building semantic graph…</div>}
          {error && <div className="absolute inset-0 z-20 grid place-items-center bg-white/85 text-sm text-red-500 backdrop-blur-sm">{error}</div>}
          {!loading && !error && (
            <ForceGraph2D<GraphNode, GraphEdge>
              ref={graphRef}
              width={size.width}
              height={size.height}
              graphData={filtered}
              backgroundColor="rgba(251,252,255,0.30)"
              nodeId="id"
              nodeVal={(node) => Math.max(2.5, Math.min(10, 2.5 + node.degree * 0.75))}
              nodeLabel={(node) => `${node.label}<br/>${node.group} · ${node.node_type} · ${node.degree} links${node.tags.length ? `<br/>#${node.tags.join(" · #")}` : ""}`}
              nodeColor={(node) => typeColor(node.node_type)}
              linkColor={(edge) => {
                if (!focusedId) return "rgba(79,111,163,0.42)";
                const isFocused = endpointId(edge.source) === focusedId || endpointId(edge.target) === focusedId;
                return isFocused ? "rgba(37,99,235,0.92)" : "rgba(148,163,184,0.08)";
              }}
              linkWidth={(edge) => {
                const isFocused = endpointId(edge.source) === focusedId || endpointId(edge.target) === focusedId;
                if (!focusedId) return 0.85 + edge.weight * 0.55;
                return isFocused ? 1.35 + edge.weight * 2.1 : 0.3;
              }}
              linkLabel={(edge) => `${edge.label}<br/>combined relevance ${Math.round(edge.weight * 100)}%`}
              linkDirectionalParticles={(edge) => {
                if (prefersReducedMotion.current || !focusedId) return 0;
                const isFocused = endpointId(edge.source) === focusedId || endpointId(edge.target) === focusedId;
                return isFocused ? 3 : 0;
              }}
              linkDirectionalParticleSpeed={0.004}
              linkDirectionalParticleWidth={(edge) => {
                const isFocused = endpointId(edge.source) === focusedId || endpointId(edge.target) === focusedId;
                return isFocused ? 2 : 0;
              }}
              linkDirectionalParticleColor={(edge) => {
                const isFocused = endpointId(edge.source) === focusedId || endpointId(edge.target) === focusedId;
                return isFocused ? "rgba(37,99,235,0.88)" : "rgba(148,163,184,0)";
              }}
              nodeCanvasObjectMode={() => "after"}
              nodeCanvasObject={(node, context, scale) => {
                const active = node.id === focusedId;
                const neighbor = focusedId ? connectedIds.has(node.id) : false;

                // Dim unrelated nodes during focus
                if (focusedId && !active && !neighbor) {
                  context.beginPath(); context.arc(node.x || 0, node.y || 0, 5, 0, Math.PI * 2);
                  context.fillStyle = "rgba(251,252,255,0.82)"; context.fill();
                }

                // Glow halo for focused node
                if (active && !prefersReducedMotion.current) {
                  context.save();
                  context.beginPath();
                  context.arc(node.x || 0, node.y || 0, 14, 0, Math.PI * 2);
                  const gradient = context.createRadialGradient(
                    node.x || 0, node.y || 0, 8,
                    node.x || 0, node.y || 0, 18
                  );
                  gradient.addColorStop(0, "rgba(59,130,246,0.26)");
                  gradient.addColorStop(1, "rgba(59,130,246,0)");
                  context.fillStyle = gradient;
                  context.fill();
                  context.restore();
                }

                // Selected node halo ring
                if (active) {
                  context.beginPath(); context.arc(node.x || 0, node.y || 0, 10, 0, Math.PI * 2);
                  context.strokeStyle = "#2563eb"; context.lineWidth = 1.8 / scale; context.stroke();
                }

                // Label rendering
                if (active || node.id === hoveredId || scale > 2.2) {
                  const fontSize = 12 / scale;
                  context.font = `${active ? 600 : 500} ${fontSize}px Inter, system-ui, sans-serif`;
                  context.textAlign = "center"; context.textBaseline = "top";
                  context.fillStyle = active ? "#172554" : "#475569";
                  context.fillText(truncate(node.label, 28), node.x || 0, (node.y || 0) + 11 / scale);
                }
              }}
              onNodeHover={(node) => setHoveredId(node?.id ? String(node.id) : null)}
              onNodeClick={(node) => setSelectedId(String(node.id))}
              onNodeDragEnd={(node) => { node.fx = node.x; node.fy = node.y; }}
              onBackgroundClick={() => setHoveredId(null)}
              warmupTicks={120}
              cooldownTicks={180}
              d3VelocityDecay={0.35}
              minZoom={0.15}
              maxZoom={8}
              onEngineStop={() => {
                if (!hasFitRef.current) {
                  hasFitRef.current = true;
                  graphRef.current?.zoomToFit(500, 70);
                }
              }}
            />
          )}
        </div>

        {/* Glass controls */}
        <div className="absolute left-3 top-3 z-10 flex gap-2">
          <Button size="sm" variant="secondary" className="border-white/80 bg-white/72 text-slate-700 shadow-sm backdrop-blur-xl hover:bg-white/95" onClick={() => setShowControls((value) => !value)}><Settings2 className="mr-1 h-4 w-4" />Controls</Button>
          <Button size="sm" variant="secondary" className="border-white/80 bg-white/72 text-slate-700 shadow-sm backdrop-blur-xl hover:bg-white/95" onClick={() => graphRef.current?.zoomToFit(500, 70)}><Maximize2 className="h-4 w-4" /></Button>
          <Button size="sm" variant="secondary" className="border-white/80 bg-white/72 text-slate-700 shadow-sm backdrop-blur-xl hover:bg-white/95" onClick={() => { setSelectedId(null); setLocalDepth(0); graphRef.current?.d3ReheatSimulation(); }}><RotateCcw className="h-4 w-4" /></Button>
        </div>

        {showControls && (
          <aside className="absolute bottom-3 left-3 top-14 z-10 w-64 overflow-y-auto rounded-2xl border border-white/90 bg-white/78 p-3 text-slate-700 shadow-[0_16px_50px_rgba(64,83,130,0.16)] backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between"><span className="text-sm font-semibold">Graph controls</span><button onClick={() => setShowControls(false)}><X className="h-4 w-4" /></button></div>
            <ControlSection title="Types" icon={<Filter className="h-3.5 w-3.5" />}>
              {typeEntries.map(([type, count]) => <FilterRow key={type} label={type} count={count} color={typeColor(type)} enabled={!hiddenTypes.has(type)} onClick={() => toggleSet(setHiddenTypes, type)} />)}
            </ControlSection>
            {tagEntries.length > 0 && <ControlSection title="Tags" icon={<ChevronDown className="h-3.5 w-3.5" />}>
              {tagEntries.map(([tag, count]) => <FilterRow key={tag} label={tag} count={count} enabled={!hiddenTags.has(tag)} onClick={() => toggleSet(setHiddenTags, tag)} />)}
            </ControlSection>}
            <ControlSection title="Display" icon={<Focus className="h-3.5 w-3.5" />}>
              <label className="flex items-center justify-between text-xs"><span>Show isolated</span><input type="checkbox" checked={showIsolated} onChange={(event) => setShowIsolated(event.target.checked)} /></label>
              <RangeControl label="Similarity" value={similarity} min={0.25} max={0.8} step={0.01} onChange={setSimilarity} display={similarity.toFixed(2)} />
              <Button size="sm" className="w-full" onClick={() => void fetchGraph(similarity)}>Apply similarity</Button>
            </ControlSection>
            <ControlSection title="Forces" icon={<Settings2 className="h-3.5 w-3.5" />}>
              <RangeControl label="Repulsion" value={repulsion} min={-300} max={-30} step={5} onChange={setRepulsion} display={String(repulsion)} />
              <RangeControl label="Link distance" value={linkDistance} min={30} max={180} step={5} onChange={setLinkDistance} display={String(linkDistance)} />
            </ControlSection>
          </aside>
        )}

        {focusedNode && (
          <aside className="absolute bottom-3 right-3 top-3 z-10 w-80 overflow-y-auto rounded-2xl border border-white/90 bg-white/82 p-4 text-slate-800 shadow-[0_16px_50px_rgba(64,83,130,0.16)] backdrop-blur-xl">
            <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: typeColor(focusedNode.node_type) }} /><span className="text-xs uppercase tracking-wide text-slate-500">{focusedNode.node_type}</span></div>
            <h2 className="mt-2 text-lg font-semibold leading-snug">{focusedNode.label}</h2>
            <p className="mt-1 text-xs text-slate-500">{focusedNode.degree} links · {focusedNode.tags.join(", ") || "No tags"}</p>
            <p className="mt-4 text-sm leading-6 text-slate-600">{focusedNode.snippet}</p>
            <div className="mt-4 flex gap-2"><Button size="sm" onClick={() => void openReader(focusedNode)}>Read note</Button><Button size="sm" variant="secondary" onClick={() => { setSelectedId(focusedNode.id); setLocalDepth(localDepth || 1); }}>{localDepth ? `Depth ${localDepth}` : "Local graph"}</Button></div>
            {localDepth > 0 && <div className="mt-3 flex items-center gap-2 text-xs"><span className="text-slate-500">Depth</span>{[1, 2, 3].map((depth) => <button key={depth} onClick={() => setLocalDepth(depth)} className={`rounded px-2 py-1 ${localDepth === depth ? "bg-blue-600 text-white" : "bg-blue-50 text-slate-600"}`}>{depth}</button>)}<button onClick={() => setLocalDepth(0)} className="ml-auto text-slate-500">Global</button></div>}
            <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-500">Strongest related notes</h3>
            <div className="mt-2 space-y-2">{related.map(({ edge, node }) => <button key={node.id} onClick={() => void openReader(node)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-blue-100/80 bg-white/70 px-3 py-2 text-left text-xs shadow-sm hover:bg-blue-50/80"><span className="truncate">{node.label}</span><span className="text-slate-500">{Math.round(edge.weight * 100)}%</span></button>)}</div>
          </aside>
        )}

        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/90 bg-white/72 px-3 py-1.5 text-[11px] text-slate-500 shadow-sm backdrop-blur-xl">Scroll to zoom · Drag canvas to pan · Drag nodes to pin · Click for local context</div>
      </div>

    </div>
  );
}

function ControlSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="mb-5 space-y-2"><h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{icon}{title}</h3>{children}</section>;
}

function FilterRow({ label, count, color, enabled, onClick }: { label: string; count: number; color?: string; enabled: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-xs hover:bg-blue-50/80 ${enabled ? "" : "opacity-40"}`}><span className="grid h-4 w-4 place-items-center rounded border border-slate-300">{enabled && <Check className="h-3 w-3" />}</span>{color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />}<span className="truncate">{label}</span><span className="ml-auto text-slate-400">{count}</span></button>;
}

function RangeControl({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; display: string }) {
  return <label className="block text-xs"><span className="mb-1 flex justify-between text-slate-600"><span>{label}</span><span className="text-slate-400">{display}</span></span><input className="w-full accent-blue-500" type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
