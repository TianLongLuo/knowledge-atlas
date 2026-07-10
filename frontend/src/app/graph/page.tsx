"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { getToken } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  label: string;
  group: string;
  size: number;
  snippet: string;
}

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  label: string;
}

interface SimNode {
  id: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
  label: CSS2DObject;
  edges: GraphEdge[];
}

// ── Colors ────────────────────────────────────────────────────

const GROUP_COLORS: Record<string, string> = {
  "商业": "#f97316", "产品": "#3b82f6", "运营": "#8b5cf6",
  "营销": "#ec4899", "思考": "#10b981", "生活": "#f59e0b",
  "技术": "#06b6d4", "学习": "#6366f1", "创作": "#ef4444",
  "随笔": "#84cc16",
};

// ── Constants ─────────────────────────────────────────────────

const CENTER_FORCE = 0.003;       // pull toward origin
const REPULSION = 6000;           // node-node repulsion
const ATTRACTION = 0.008;         // edge spring attraction
const DAMPING = 0.92;             // velocity decay
const IDEAL_EDGE_LEN = 60;        // target edge length
const MAX_VEL = 12;               // cap velocity per frame
const SIM_ALPHA_DECAY = 0.9995;   // slow cooldown

// ── Component ─────────────────────────────────────────────────

export default function Graph3DPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [filterGroup, setFilterGroup] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [minSim, setMinSim] = useState(0.25);

  const simAlphaRef = useRef(1.0);
  const simNodesRef = useRef<SimNode[]>([]);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number>(0);
  const pickableRef = useRef<THREE.Mesh[]>([]);

  // ── Fetch data ──────────────────────────────────────────────

  const fetchData = useCallback(async (sim?: number) => {
    setLoading(true);
    const token = getToken();
    try {
      const s = sim ?? minSim;
      const res = await fetch(`/api/graph/full?limit=200&min_similarity=${s}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await res.json();
      setData(d);
      setSelected(null);
      simAlphaRef.current = 1.0;
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [minSim]);

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build / rebuild 3D scene ────────────────────────────────

  useEffect(() => {
    if (!data || !containerRef.current) return;

    // Cleanup previous
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    const oldCanvas = containerRef.current.querySelector("canvas");
    if (oldCanvas) oldCanvas.remove();
    const oldLabels = containerRef.current.querySelector(".css2d-labels");
    if (oldLabels) oldLabels.remove();

    const container = containerRef.current;
    const W = container.clientWidth;
    const H = container.clientHeight;

    // ── Scene ─────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    scene.fog = new THREE.FogExp2(0x0f172a, 0.00015);
    sceneRef.current = scene;

    // ── Camera ────────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(55, W / H, 1, 3000);
    camera.position.set(0, 80, 420);
    cameraRef.current = camera;

    // ── Renderers ─────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(W, H);
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    labelRenderer.domElement.classList.add("css2d-labels");
    container.appendChild(labelRenderer.domElement);

    // ── Controls ──────────────────────────────────────────────
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 40;
    controls.maxDistance = 1200;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.25;
    controlsRef.current = controls;

    // ── Lights ────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x404060, 2.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 1, 0.8);
    scene.add(dirLight);

    const backLight = new THREE.DirectionalLight(0x4488ff, 0.5);
    backLight.position.set(-1, -0.5, -1);
    scene.add(backLight);

    // ── Stars ─────────────────────────────────────────────────
    const starsGeo = new THREE.BufferGeometry();
    const starsVerts: number[] = [];
    for (let i = 0; i < 2000; i++) {
      starsVerts.push(
        (Math.random() - 0.5) * 2000,
        (Math.random() - 0.5) * 2000,
        (Math.random() - 0.5) * 2000,
      );
    }
    starsGeo.setAttribute("position", new THREE.Float32BufferAttribute(starsVerts, 3));
    scene.add(new THREE.Points(starsGeo, new THREE.PointsMaterial({ color: 0x475569, size: 0.6 })));

    // ── Filter nodes ──────────────────────────────────────────
    const filtered = filterGroup
      ? data.nodes.filter((n) => n.group === filterGroup)
      : data.nodes;
    const filteredIds = new Set(filtered.map((n) => n.id));

    // ── Edge map ──────────────────────────────────────────────
    const edgeMap = new Map<string, GraphEdge[]>();
    for (const node of filtered) edgeMap.set(node.id, []);
    for (const e of data.edges) {
      if (!filteredIds.has(e.source) || !filteredIds.has(e.target)) continue;
      edgeMap.get(e.source)?.push(e);
      edgeMap.get(e.target)?.push(e);
    }

    // ── Build sim nodes ───────────────────────────────────────
    const simNodes: SimNode[] = [];
    const sphereGeo = new THREE.SphereGeometry(3.5, 20, 20);
    const pickable: THREE.Mesh[] = [];

    filtered.forEach((node, i) => {
      const color = new THREE.Color(GROUP_COLORS[node.group] || "#94a3b8");
      const mat = new THREE.MeshPhongMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.25,
        shininess: 40,
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);

      // Fibonacci sphere initial positions
      const phi = Math.acos(1 - 2 * (i + 0.5) / filtered.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 250 + Math.random() * 80;
      mesh.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
      mesh.userData = { node };
      scene.add(mesh);
      pickable.push(mesh);

      // CSS label
      const labelDiv = document.createElement("div");
      labelDiv.textContent = node.label;
      labelDiv.style.cssText = `
        color: #e2e8f0; font-size: 9px; font-family: sans-serif;
        background: rgba(15, 23, 42, 0.85); padding: 2px 6px;
        border-radius: 4px; white-space: nowrap;
        border: 1px solid ${GROUP_COLORS[node.group] || "#94a3b8"}44;
      `;
      const label = new CSS2DObject(labelDiv);
      label.position.copy(mesh.position.clone().add(new THREE.Vector3(0, 7, 0)));
      scene.add(label);

      simNodes.push({
        id: node.id,
        pos: mesh.position.clone(),
        vel: new THREE.Vector3(),
        mesh,
        label,
        edges: edgeMap.get(node.id) || [],
      });
    });

    simNodesRef.current = simNodes;
    pickableRef.current = pickable;

    // Capture data in closure-safe refs
    const edgesRef = data.edges;
    const nodesRef = data.nodes;

    // ── Edge lines ────────────────────────────────────────────
    const edgeLines: THREE.Line[] = [];
    const drawnEdges = new Set<string>();
    for (const e of edgesRef) {
      if (!filteredIds.has(e.source) || !filteredIds.has(e.target)) continue;
      const key = [e.source, e.target].sort().join("::");
      if (drawnEdges.has(key)) continue;
      drawnEdges.add(key);

      const src = simNodes.find((n) => n.id === e.source);
      const tgt = simNodes.find((n) => n.id === e.target);
      if (!src || !tgt) continue;

      const lineGeo = new THREE.BufferGeometry().setFromPoints([src.pos, tgt.pos]);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x475569,
        transparent: true,
        opacity: Math.min(e.weight * 0.5, 0.7),
        linewidth: 1,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      scene.add(line);
      edgeLines.push(line);
    }

    // ── Raycaster ─────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 8;
    const mouse = new THREE.Vector2();
    let hovered: THREE.Mesh | null = null;

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onClick = () => {
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(pickable);
      if (hits.length > 0) {
        const node = hits[0].object.userData.node as GraphNode;
        setSelected(node);
      } else {
        setSelected(null);
      }
    };

    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("click", onClick);

    // ── Animation loop WITH force simulation ──────────────────
    function animate() {
      animFrameRef.current = requestAnimationFrame(animate);

      // ── Force simulation (live, every frame) ────────────────
      if (running && simAlphaRef.current > 0.001) {
        const sn = simNodes;
        const alpha = simAlphaRef.current;

        for (let i = 0; i < sn.length; i++) {
          const a = sn[i];

          // Repulsion between all pairs
          for (let j = i + 1; j < sn.length; j++) {
            const b = sn[j];
            const dx = b.pos.x - a.pos.x;
            const dy = b.pos.y - a.pos.y;
            const dz = b.pos.z - a.pos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
            const force = REPULSION / (dist * dist);
            const fx = (dx / dist) * force * alpha;
            const fy = (dy / dist) * force * alpha;
            const fz = (dz / dist) * force * alpha;
            a.vel.x -= fx; a.vel.y -= fy; a.vel.z -= fz;
            b.vel.x += fx; b.vel.y += fy; b.vel.z += fz;
          }

          // Edge attraction (spring)
          for (const edge of a.edges) {
            const otherId = edge.source === a.id ? edge.target : edge.source;
            const b = sn.find((x) => x.id === otherId);
            if (!b) continue;
            const dx = b.pos.x - a.pos.x;
            const dy = b.pos.y - a.pos.y;
            const dz = b.pos.z - a.pos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
            const displacement = dist - IDEAL_EDGE_LEN;
            const force = displacement * ATTRACTION * edge.weight * alpha;
            a.vel.x += (dx / dist) * force;
            a.vel.y += (dy / dist) * force;
            a.vel.z += (dz / dist) * force;
          }

          // Center gravity
          a.vel.x -= a.pos.x * CENTER_FORCE * alpha;
          a.vel.y -= a.pos.y * CENTER_FORCE * alpha;
          a.vel.z -= a.pos.z * CENTER_FORCE * alpha;
        }

        // Apply velocities with damping + cap
        for (const n of sn) {
          const speed = n.vel.length();
          if (speed > MAX_VEL) {
            n.vel.multiplyScalar(MAX_VEL / speed);
          }
          n.vel.multiplyScalar(DAMPING);
          n.pos.add(n.vel);
          n.mesh.position.copy(n.pos);
          n.label.position.copy(n.pos.clone().add(new THREE.Vector3(0, 7, 0)));
        }

        simAlphaRef.current *= SIM_ALPHA_DECAY;
      }

      // Update edge lines geometry each frame for live edges
      for (let i = 0; i < edgeLines.length; i++) {
        const e = edgesRef[i];
        if (!e) continue;
        const src = simNodes.find((n) => n.id === e.source);
        const tgt = simNodes.find((n) => n.id === e.target);
        if (!src || !tgt) continue;
        const positions = edgeLines[i].geometry.attributes.position;
        positions.setXYZ(0, src.pos.x, src.pos.y, src.pos.z);
        positions.setXYZ(1, tgt.pos.x, tgt.pos.y, tgt.pos.z);
        positions.needsUpdate = true;
      }

      // ── Hover detection ────────────────────────────────────
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObjects(pickable);

      if (hovered) {
        (hovered.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.25;
        hovered.scale.set(1, 1, 1);
        hovered = null;
      }
      if (hits.length > 0) {
        hovered = hits[0].object as THREE.Mesh;
        (hovered.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.8;
        hovered.scale.set(1.6, 1.6, 1.6);
        container.style.cursor = "pointer";
      } else {
        container.style.cursor = "grab";
      }

      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }

    animate();

    // ── Cleanup ───────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("click", onClick);
      renderer.dispose();
      labelRenderer.domElement.remove();
      renderer.domElement.remove();
      controls.dispose();
    };
  }, [data, filterGroup, running]);

  // ── Loading state ───────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-slate-400">加载知识宇宙...</p>
        </div>
      </div>
    );
  }

  const groups = [...new Set((data?.nodes || []).map((n) => n.group))].sort();

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">知识网络</h1>
          <p className="text-slate-400 text-sm">
            {data?.nodes.length || 0} 节点 · {data?.edges.length || 0} 关联 (向量语义)
            {selected && (
              <span className="text-blue-400 ml-2">
                | 选中: {selected.label}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Similarity threshold slider */}
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>相关性</span>
            <input
              type="range"
              min="0.15"
              max="0.6"
              step="0.05"
              value={minSim}
              onChange={(e) => { setMinSim(parseFloat(e.target.value)); }}
              onMouseUp={() => fetchData(minSim)}
              className="w-20 h-1 accent-blue-500"
            />
            <span className="w-8">{minSim.toFixed(2)}</span>
          </div>

          {/* Pause / Resume */}
          <button
            onClick={() => { setRunning(!running); if (!running) simAlphaRef.current = 0.8; }}
            className={`px-3 py-1 rounded text-xs font-medium transition ${
              running
                ? "bg-green-600/20 text-green-400 border border-green-600/40"
                : "bg-slate-700 text-slate-300 border border-slate-600"
            }`}
          >
            {running ? "▮▮ 暂停布局" : "▶ 恢复布局"}
          </button>
        </div>
      </div>

      {/* Filter tags */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setFilterGroup(null)}
          className={`px-3 py-1 rounded text-xs font-medium transition ${
            !filterGroup
              ? "bg-blue-600 text-white"
              : "bg-slate-800 text-slate-400 hover:bg-slate-700"
          }`}
        >
          全部
        </button>
        {groups.map((g) => (
          <button
            key={g}
            onClick={() => setFilterGroup(g === filterGroup ? null : g)}
            className="px-3 py-1 rounded text-xs font-medium transition"
            style={{
              backgroundColor: filterGroup === g ? GROUP_COLORS[g] : "rgb(30, 41, 59)",
              color: filterGroup === g ? "#fff" : GROUP_COLORS[g],
              border: `1px solid ${GROUP_COLORS[g]}44`,
            }}
          >
            {g}
          </button>
        ))}
      </div>

      {/* 3D Canvas */}
      <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden relative">
        <div ref={containerRef} style={{ width: "100%", height: "72vh" }} />
        <div className="absolute bottom-3 left-3 text-xs text-slate-600 flex gap-4">
          <span>🖱 拖拽旋转</span>
          <span>🔍 滚轮缩放</span>
          <span>👆 点击选中</span>
        </div>
      </div>

      {/* Selected node detail */}
      {selected && (
        <div className="bg-slate-800/90 border border-slate-700 rounded-lg p-4 backdrop-blur">
          <div className="flex items-center gap-3 mb-2">
            <span
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: GROUP_COLORS[selected.group] || "#94a3b8" }}
            />
            <h3 className="text-white font-medium text-lg">{selected.label}</h3>
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{
                backgroundColor: (GROUP_COLORS[selected.group] || "#94a3b8") + "22",
                color: GROUP_COLORS[selected.group] || "#94a3b8",
              }}
            >
              {selected.group}
            </span>
          </div>
          {selected.snippet && (
            <p className="text-slate-300 text-sm leading-relaxed">{selected.snippet}</p>
          )}
          {/* Show connected nodes */}
          {(() => {
            const connected = data?.edges
              .filter((e) => e.source === selected.id || e.target === selected.id)
              .slice(0, 8) || [];
            if (connected.length === 0) return null;
            return (
              <div className="mt-3">
                <p className="text-xs text-slate-500 mb-2">
                  关联文档 ({connected.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {connected.map((e) => {
                    const otherId = e.source === selected.id ? e.target : e.source;
                    const otherNode = data?.nodes.find((n) => n.id === otherId);
                    return otherNode ? (
                      <span
                        key={e.source + e.target}
                        className="text-xs px-2 py-1 rounded bg-slate-700/60 text-slate-300 border border-slate-600/50"
                        title={`相似度: ${(e.weight * 100).toFixed(0)}%`}
                      >
                        {otherNode.label}
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
