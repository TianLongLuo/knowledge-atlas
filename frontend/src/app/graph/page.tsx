"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
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
interface SimNode {
  index: number;
  data: GraphNode;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
  label: CSS2DObject;
  labelElement: HTMLDivElement;
}
interface SimEdge { data: GraphEdge; source: SimNode; target: SimNode }

const COLORS: Record<string, string> = {
  商业: "#f97316", 产品: "#3b82f6", 运营: "#8b5cf6", 营销: "#ec4899",
  思考: "#10b981", 生活: "#f59e0b", 技术: "#06b6d4", 学习: "#6366f1",
  创作: "#ef4444", 随笔: "#84cc16",
};
const CELL_SIZE = 90;
const NEIGHBOR_CELLS = [-1, 0, 1];

function seededPosition(id: string, index: number, count: number) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  const jitter = ((hash >>> 0) % 1000) / 1000;
  const phi = Math.acos(1 - (2 * (index + 0.5)) / Math.max(count, 1));
  const theta = Math.PI * (1 + Math.sqrt(5)) * (index + jitter);
  const radius = 210 + jitter * 90;
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.sin(phi) * Math.sin(theta),
    radius * Math.cos(phi),
  );
}

export default function GraphPage() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(true);
  const animationRef = useRef(0);
  const alphaRef = useRef(1);
  const controlsRef = useRef<OrbitControls | null>(null);
  const simNodeMapRef = useRef<Map<string, SimNode>>(new Map());

  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [minSimilarity, setMinSimilarity] = useState(0.35);
  const [query, setQuery] = useState("");

  useEffect(() => { runningRef.current = running; }, [running]);

  const fetchData = useCallback(async (threshold: number) => {
    setLoading(true);
    setError("");
    try {
      const graph = await apiFetch<GraphData>(
        `/graph/full?limit=240&neighbors=12&min_similarity=${threshold}&max_edges=1400`,
      );
      setData(graph);
      setSelected(null);
      setFocusNodeId(null);
      alphaRef.current = 1;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "知识网络加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(0.35); }, [fetchData]);
  useEffect(() => {
    if (!data) return;
    const timer = window.setTimeout(() => { void fetchData(minSimilarity); }, 350);
    return () => window.clearTimeout(timer);
    // Data is intentionally excluded: only a slider change schedules a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minSimilarity, fetchData]);

  const groups = useMemo(() => Object.keys(data?.stats.groups || {}).sort(), [data]);
  const visibleData = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    let allowed = new Set(data.nodes.filter((node) => !filterGroup || node.group === filterGroup).map((node) => node.id));
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
  }, [data, filterGroup, focusNodeId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || visibleData.nodes.length === 0) return;
    cancelAnimationFrame(animationRef.current);
    container.replaceChildren();

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07101f);
    scene.fog = new THREE.FogExp2(0x07101f, 0.00028);
    const camera = new THREE.PerspectiveCamera(52, 1, 1, 2600);
    camera.position.set(0, 80, 430);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.className = "graph-label-layer";
    Object.assign(labelRenderer.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minDistance = 35;
    controls.maxDistance = 1200;
    controls.autoRotate = !focusNodeId;
    controls.autoRotateSpeed = 0.2;
    controlsRef.current = controls;

    scene.add(new THREE.HemisphereLight(0x93c5fd, 0x111827, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(180, 240, 160);
    scene.add(keyLight);

    const starGeometry = new THREE.BufferGeometry();
    const stars = new Float32Array(1800 * 3);
    for (let i = 0; i < stars.length; i += 1) stars[i] = (Math.random() - 0.5) * 1900;
    starGeometry.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    const starMaterial = new THREE.PointsMaterial({ color: 0x334155, size: 0.65 });
    scene.add(new THREE.Points(starGeometry, starMaterial));

    const sphereGeometry = new THREE.SphereGeometry(3.6, 14, 10);
    const materials = new Map<string, THREE.MeshPhongMaterial>();
    const importantLabels = new Set(
      [...visibleData.nodes].sort((a, b) => b.degree - a.degree).slice(0, 36).map((node) => node.id),
    );
    const simNodes: SimNode[] = [];
    const nodeMap = new Map<string, SimNode>();

    visibleData.nodes.forEach((node, index) => {
      const color = COLORS[node.group] || "#94a3b8";
      let material = materials.get(color);
      if (!material) {
        material = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.25, shininess: 48 });
        materials.set(color, material);
      }
      const mesh = new THREE.Mesh(sphereGeometry, material);
      const scale = Math.max(0.8, Math.min(2.25, node.size / 8));
      mesh.scale.setScalar(scale);
      const position = seededPosition(node.id, index, visibleData.nodes.length);
      mesh.position.copy(position);
      mesh.userData.nodeId = node.id;
      scene.add(mesh);

      const labelElement = document.createElement("div");
      labelElement.textContent = node.label;
      labelElement.className = "rounded border px-1.5 py-0.5 text-[10px] text-slate-200 backdrop-blur-sm";
      labelElement.style.background = "rgba(7, 16, 31, .78)";
      labelElement.style.borderColor = `${color}55`;
      labelElement.style.display = importantLabels.has(node.id) ? "block" : "none";
      const label = new CSS2DObject(labelElement);
      label.position.set(0, 7 * scale, 0);
      mesh.add(label);

      const simNode = { index, data: node, pos: position, vel: new THREE.Vector3(), mesh, label, labelElement };
      simNodes.push(simNode);
      nodeMap.set(node.id, simNode);
    });
    simNodeMapRef.current = nodeMap;

    const simEdges: SimEdge[] = visibleData.edges.flatMap((edge) => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      return source && target ? [{ data: edge, source, target }] : [];
    });
    const edgePositions = new Float32Array(simEdges.length * 6);
    const edgeColors = new Float32Array(simEdges.length * 6);
    const weakEdge = new THREE.Color(0x334155);
    const strongEdge = new THREE.Color(0x60a5fa);
    simEdges.forEach((edge, index) => {
      const color = weakEdge.clone().lerp(strongEdge, Math.max(0, Math.min(1, edge.data.weight)));
      const offset = index * 6;
      edgeColors[offset] = color.r; edgeColors[offset + 1] = color.g; edgeColors[offset + 2] = color.b;
      edgeColors[offset + 3] = color.r; edgeColors[offset + 4] = color.g; edgeColors[offset + 5] = color.b;
    });
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5 });
    const edgeSegments = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    scene.add(edgeSegments);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2(2, 2);
    const pickables = simNodes.map((node) => node.mesh);
    let hovered: SimNode | null = null;
    let pointerDirty = true;
    let frame = 0;

    const updatePointer = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      pointerDirty = true;
    };
    const pickNode = () => {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(pickables, false)[0];
      return hit ? nodeMap.get(String(hit.object.userData.nodeId)) || null : null;
    };
    const handleClick = () => {
      const hit = pickNode();
      setSelected(hit?.data || null);
      if (hit) {
        controls.autoRotate = false;
        controls.target.copy(hit.pos);
        const direction = camera.position.clone().sub(hit.pos).normalize();
        camera.position.copy(hit.pos).add(direction.multiplyScalar(125));
      }
    };
    const handleDoubleClick = () => {
      const hit = pickNode();
      if (hit) router.push(`/documents/${hit.data.document_id}`);
    };
    container.addEventListener("pointermove", updatePointer);
    container.addEventListener("click", handleClick);
    container.addEventListener("dblclick", handleDoubleClick);

    const resize = () => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      labelRenderer.setSize(width, height);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const simulate = () => {
      const alpha = alphaRef.current;
      const grid = new Map<string, SimNode[]>();
      simNodes.forEach((node) => {
        const key = `${Math.floor(node.pos.x / CELL_SIZE)},${Math.floor(node.pos.y / CELL_SIZE)},${Math.floor(node.pos.z / CELL_SIZE)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(node); else grid.set(key, [node]);
      });
      simNodes.forEach((node) => {
        const cx = Math.floor(node.pos.x / CELL_SIZE);
        const cy = Math.floor(node.pos.y / CELL_SIZE);
        const cz = Math.floor(node.pos.z / CELL_SIZE);
        for (const dx of NEIGHBOR_CELLS) {
          for (const dy of NEIGHBOR_CELLS) {
            for (const dz of NEIGHBOR_CELLS) {
              const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`) || [];
              bucket.forEach((other) => {
                if (other.index <= node.index) return;
                const delta = other.pos.clone().sub(node.pos);
                const distanceSq = Math.max(delta.lengthSq(), 16);
                const force = (5200 / distanceSq) * alpha;
                delta.normalize().multiplyScalar(force);
                node.vel.sub(delta);
                other.vel.add(delta);
              });
            }
          }
        }
        node.vel.addScaledVector(node.pos, -0.0028 * alpha);
      });
      simEdges.forEach((edge) => {
        const delta = edge.target.pos.clone().sub(edge.source.pos);
        const distance = Math.max(delta.length(), 0.1);
        const ideal = 54 + (1 - edge.data.weight) * 42;
        const force = (distance - ideal) * 0.0065 * edge.data.weight * alpha;
        delta.multiplyScalar(force / distance);
        edge.source.vel.add(delta);
        edge.target.vel.sub(delta);
      });
      simNodes.forEach((node) => {
        node.vel.clampLength(0, 10).multiplyScalar(0.89);
        node.pos.add(node.vel);
        node.mesh.position.copy(node.pos);
      });
      alphaRef.current *= 0.992;
    };

    const render = () => {
      animationRef.current = requestAnimationFrame(render);
      frame += 1;
      if (runningRef.current && alphaRef.current > 0.006 && frame % 2 === 0) simulate();

      simEdges.forEach((edge, index) => {
        const offset = index * 6;
        edgePositions[offset] = edge.source.pos.x; edgePositions[offset + 1] = edge.source.pos.y; edgePositions[offset + 2] = edge.source.pos.z;
        edgePositions[offset + 3] = edge.target.pos.x; edgePositions[offset + 4] = edge.target.pos.y; edgePositions[offset + 5] = edge.target.pos.z;
      });
      (edgeGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      if (pointerDirty) {
        pointerDirty = false;
        const next = pickNode();
        if (next !== hovered) {
          if (hovered) {
            hovered.mesh.scale.multiplyScalar(1 / 1.35);
            if (!importantLabels.has(hovered.data.id)) hovered.labelElement.style.display = "none";
          }
          hovered = next;
          if (hovered) {
            hovered.mesh.scale.multiplyScalar(1.35);
            hovered.labelElement.style.display = "block";
          }
          container.style.cursor = hovered ? "pointer" : "grab";
        }
      }
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    render();

    return () => {
      cancelAnimationFrame(animationRef.current);
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", updatePointer);
      container.removeEventListener("click", handleClick);
      container.removeEventListener("dblclick", handleDoubleClick);
      controls.dispose();
      sphereGeometry.dispose();
      materials.forEach((material) => material.dispose());
      edgeGeometry.dispose(); edgeMaterial.dispose(); starGeometry.dispose(); starMaterial.dispose(); renderer.dispose();
      container.replaceChildren();
      simNodeMapRef.current.clear();
    };
  }, [visibleData, focusNodeId, router]);

  const connected = selected && data
    ? data.edges.filter((edge) => edge.source === selected.id || edge.target === selected.id)
        .sort((a, b) => b.weight - a.weight).slice(0, 10)
    : [];
  const searchResults = query.trim() && data
    ? data.nodes.filter((node) => node.label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6)
    : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">知识网络</h1>
          <p className="text-sm text-muted-foreground">
            {data?.stats.node_count || 0} 节点 · {data?.stats.edge_count || 0} 条 Top‑K 语义边 · {data?.stats.isolated_count || 0} 个孤立节点
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            相似度
            <input type="range" min="0.15" max="0.75" step="0.05" value={minSimilarity}
              onChange={(event) => setMinSimilarity(Number(event.target.value))} className="w-24 accent-blue-500" />
            <span className="w-8">{minSimilarity.toFixed(2)}</span>
          </label>
          <button onClick={() => { setRunning((value) => !value); alphaRef.current = 0.7; }}
            className="rounded border border-border bg-card px-3 py-1.5 hover:bg-accent">
            {running ? "暂停布局" : "恢复布局"}
          </button>
          <button onClick={() => void fetchData(minSimilarity)} className="rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500">刷新</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setFilterGroup(null)} className={`rounded px-3 py-1 text-xs ${!filterGroup ? "bg-blue-600 text-white" : "bg-card text-muted-foreground"}`}>全部</button>
        {groups.map((group) => (
          <button key={group} onClick={() => setFilterGroup(filterGroup === group ? null : group)}
            className="rounded border px-3 py-1 text-xs" style={{ borderColor: `${COLORS[group] || "#94a3b8"}66`, color: COLORS[group] || "#94a3b8" }}>
            {group} {data?.stats.groups[group] || 0}
          </button>
        ))}
        {focusNodeId && <button onClick={() => setFocusNodeId(null)} className="rounded bg-amber-500/15 px-3 py-1 text-xs text-amber-400">退出局部图</button>}
        <div className="relative ml-auto min-w-52">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找节点…"
            className="w-full rounded border border-border bg-card px-3 py-1.5 text-xs outline-none focus:border-blue-500" />
          {searchResults.length > 0 && (
            <div className="absolute right-0 top-full z-20 mt-1 w-full rounded border border-border bg-popover p-1 shadow-xl">
              {searchResults.map((node) => <button key={node.id} onClick={() => { setSelected(node); setFocusNodeId(node.id); setQuery(""); }}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent">{node.label}</button>)}
            </div>
          )}
        </div>
      </div>

      <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
        {loading && <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/75 text-sm text-slate-300">正在构建知识网络…</div>}
        {error && <div className="absolute inset-0 z-10 grid place-items-center bg-slate-950/90 text-sm text-red-300">{error}</div>}
        {!loading && !error && visibleData.nodes.length === 0 && <div className="absolute inset-0 z-10 grid place-items-center text-sm text-slate-400">当前筛选没有可展示节点</div>}
        <div ref={containerRef} className="h-[72vh] min-h-[520px] w-full" />
        <div className="pointer-events-none absolute bottom-3 left-3 flex gap-4 text-[11px] text-slate-500">
          <span>拖拽旋转</span><span>滚轮缩放</span><span>单击聚焦</span><span>双击打开文档</span>
        </div>
      </div>

      {selected && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: COLORS[selected.group] || "#94a3b8" }} />
            <h2 className="font-semibold">{selected.label}</h2>
            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{selected.group} · {selected.degree} 个连接</span>
            <div className="ml-auto flex gap-2">
              <button onClick={() => setFocusNodeId(selected.id)} className="rounded border border-border px-3 py-1 text-xs hover:bg-accent">只看一层邻域</button>
              <button onClick={() => router.push(`/documents/${selected.document_id}`)} className="rounded bg-blue-600 px-3 py-1 text-xs text-white">打开文档</button>
            </div>
          </div>
          {selected.snippet && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{selected.snippet}</p>}
          {connected.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">
            {connected.map((edge) => {
              const otherId = edge.source === selected.id ? edge.target : edge.source;
              const node = data?.nodes.find((candidate) => candidate.id === otherId);
              return node ? <button key={`${edge.source}:${edge.target}`} onClick={() => { setSelected(node); setFocusNodeId(node.id); }}
                className="rounded border border-border bg-muted/40 px-2 py-1 text-xs hover:bg-accent" title={`相似度 ${(edge.weight * 100).toFixed(1)}%`}>
                {node.label} · {(edge.weight * 100).toFixed(0)}%
              </button> : null;
            })}
          </div>}
        </div>
      )}
    </div>
  );
}
