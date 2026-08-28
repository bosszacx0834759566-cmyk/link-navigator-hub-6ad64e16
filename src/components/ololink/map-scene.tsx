'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import earthDay from '@/assets/earth_atmos_2048.jpg';
import { earthBasemap } from '@/lib/earth-basemap';
import { cn } from '@/lib/utils';
import type { OloLinkState } from '@/hooks/use-ololink';
import {
  ASSETS,
  ASSET_BY_ID,
  STATUS_META,
  TECH_META,
  type Asset,
  type AssetKind,
} from '@/lib/ololink';
import { REGIONS } from '@/lib/layers';
import { MAP_H, MAP_W, arcPath, livePosition, project, sceneTime, type LatLon } from '@/lib/geo2d';

const KIND_COLOR: Record<AssetKind, string> = {
  satellite: '#7dd3fc',
  haps: '#38bdf8',
  drone: '#a5b4fc',
  ground: '#34d399',
  customer: '#e2e8f0',
};

const WEATHER_COLOR = { CLOUD: '#94a3b8', RAIN: '#38bdf8', STORM: '#f472b6' } as const;

/** Nodes render at slightly different sizes so the altitude tiers stay readable. */
/** vertical label stagger keeps the surface cluster (GS / customer / drone) legible */
const LABEL_DY: Record<AssetKind, number> = {
  satellite: -9,
  haps: -16,
  drone: 15,
  ground: 10,
  customer: 20,
};

/** surface assets sit within ~1 degree of each other — fan them out in screen space */
const PIXEL_OFFSET: Record<AssetKind, { x: number; y: number }> = {
  satellite: { x: 0, y: 0 },
  haps: { x: -26, y: -18 },
  drone: { x: -30, y: 14 },
  ground: { x: 0, y: 0 },
  customer: { x: 30, y: 16 },
};

const KIND_SIZE: Record<AssetKind, number> = {
  satellite: 5,
  haps: 4.5,
  drone: 4,
  ground: 5,
  customer: 4.5,
};

function NodeGlyph({ kind, color }: { kind: AssetKind; color: string }) {
  const r = KIND_SIZE[kind];
  if (kind === 'satellite') {
    return (
      <g>
        <rect x={-r * 0.5} y={-r * 0.5} width={r} height={r} fill={color} />
        <rect x={-r * 1.7} y={-r * 0.28} width={r * 0.9} height={r * 0.56} fill={color} fillOpacity={0.55} />
        <rect x={r * 0.8} y={-r * 0.28} width={r * 0.9} height={r * 0.56} fill={color} fillOpacity={0.55} />
      </g>
    );
  }
  if (kind === 'haps') {
    return <ellipse rx={r * 1.5} ry={r * 0.62} fill={color} fillOpacity={0.75} stroke={color} strokeWidth={0.6} />;
  }
  if (kind === 'drone') {
    return (
      <g stroke={color} strokeWidth={0.9} fill="none">
        <path d={`M ${-r} ${-r} L ${r} ${r} M ${r} ${-r} L ${-r} ${r}`} strokeOpacity={0.7} />
        <rect x={-r * 0.42} y={-r * 0.42} width={r * 0.84} height={r * 0.84} fill={color} />
      </g>
    );
  }
  if (kind === 'ground') {
    return (
      <g>
        <circle r={r * 0.62} fill={color} />
        <circle r={r * 1.35} fill="none" stroke={color} strokeWidth={0.7} strokeOpacity={0.55} />
      </g>
    );
  }
  return (
    <g>
      <rect x={-r * 0.75} y={-r * 0.75} width={r * 1.5} height={r * 1.5} fill="none" stroke={color} strokeWidth={1} />
      <circle r={r * 0.3} fill={color} />
    </g>
  );
}

/**
 * 2D operational map — the same mission state as the globe, projected
 * equirectangularly and optimised for network routing clarity.
 */
export function MapScene({ state }: { state: OloLinkState }) {
  const { links, route, profile, selection, layers, techFilter, telemetry } = state;

  // shared scene clock -> live satellite ground tracks
  const [t, setT] = useState(() => sceneTime());
  const raf = useRef<number>(0);
  useEffect(() => {
    if (!state.running) return;
    const loop = () => {
      setT(sceneTime());
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [state.running]);

  const positions = useMemo(() => {
    const map: Record<string, LatLon> = {};
    for (const a of ASSETS) map[a.id] = livePosition(a, t);
    return map;
  }, [t]);

  const routeIds = useMemo(() => new Set(route.map((s) => s.id)), [route]);
  const visibleLinks = useMemo(
    () => links.filter((l) => techFilter[l.segment.tech]),
    [links, techFilter]
  );

  const selectedAsset = selection?.type === 'asset' ? selection.id : null;
  const selectedLink = selection?.type === 'link' ? selection.id : null;
  const activeRegion = selectedAsset ? ASSET_BY_ID[selectedAsset]?.region ?? null : null;

  /* ------------------------------------------------ flattened earth base */
  const [basemap, setBasemap] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    earthBasemap()
      .then((url) => {
        if (alive) setBasemap(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /* --------------------------------------------------------- pan & zoom */
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const clamp = (z: number, x: number, y: number) => ({
    z,
    x: Math.min(0, Math.max(MAP_W * (1 - z), x)),
    y: Math.min(0, Math.max(MAP_H * (1 - z), y)),
  });

  /** client point -> untransformed SVG user units */
  const toSvg = (cx: number, cy: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = cx;
    p.y = cy;
    const q = p.matrixTransform(ctm.inverse());
    return { x: q.x, y: q.y };
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      const cur = viewRef.current;
      const next = Math.min(14, Math.max(1, cur.z * Math.exp(-dy * 0.0016)));
      if (next === cur.z) return;
      const p = toSvg(e.clientX, e.clientY);
      const k = next / cur.z;
      setView(clamp(next, p.x - (p.x - cur.x) * k, p.y - (p.y - cur.y) * k));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const [grabbing, setGrabbing] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
    setGrabbing(true);
    try {
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    const scale = ctm ? ctm.a || 1 : 1;
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const cur = viewRef.current;
    setView(clamp(cur.z, cur.x + dx, cur.y + dy));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current) {
      try {
        (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
    setGrabbing(false);
    window.setTimeout(() => {
      dragRef.current = null;
    }, 0);
  };
  const dragged = () => dragRef.current?.moved ?? false;


  const z = view.z;
  const inv = 1 / z;

  const pointOf = (id: string) => {
    const ll = positions[id];
    const asset = ASSET_BY_ID[id];
    if (!ll || !asset) return null;
    const p = project(ll.lat, ll.lon);
    const o = PIXEL_OFFSET[asset.kind];
    // pixel fan-out is a screen-space nicety — undo it as the operator zooms in
    return { x: p.x + o.x * inv, y: p.y + o.y * inv };
  };

  /** keep link endpoints on the same side of the antimeridian */
  const pairPoints = (fromId: string, toId: string) => {
    const a = pointOf(fromId);
    const b = pointOf(toId);
    if (!a || !b) return null;
    const shifted = { ...b };
    if (Math.abs(shifted.x - a.x) > MAP_W / 2) shifted.x += shifted.x > a.x ? -MAP_W : MAP_W;
    return { a, b: shifted };
  };

  return (
    <div className="relative h-full w-full bg-[#03060d]">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="xMidYMid meet"
        className={cn(
          'h-full w-full touch-none select-none [&_text]:select-none',
          grabbing ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        onDragStart={(e) => e.preventDefault()}
        onClick={() => {
          if (!dragged()) state.select(null);
        }}
      >
        <defs>
          <clipPath id="map-clip">
            <rect x={0} y={0} width={MAP_W} height={MAP_H} />
          </clipPath>
          <radialGradient id="map-vignette" cx="50%" cy="50%" r="72%">
            <stop offset="55%" stopColor="#03060d" stopOpacity="0" />
            <stop offset="100%" stopColor="#03060d" stopOpacity="0.92" />
          </radialGradient>
          <linearGradient id="map-atmos" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7fb3e8" stopOpacity="0.16" />
            <stop offset="26%" stopColor="#4a86c8" stopOpacity="0.04" />
            <stop offset="74%" stopColor="#4a86c8" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#7fb3e8" stopOpacity="0.16" />
          </linearGradient>
          {/* smooth heat-map style weather gradients */}
          <radialGradient id="wx-cloud">
            <stop offset="0%" stopColor="#cbd5e1" stopOpacity="0.28" />
            <stop offset="45%" stopColor="#b6c3d4" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#b6c3d4" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="wx-rain">
            <stop offset="0%" stopColor="#7dd3fc" stopOpacity="0.3" />
            <stop offset="45%" stopColor="#38bdf8" stopOpacity="0.17" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="wx-storm">
            <stop offset="0%" stopColor="#f9a8d4" stopOpacity="0.32" />
            <stop offset="45%" stopColor="#f472b6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#f472b6" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g clipPath="url(#map-clip)">
        <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>

          {/* deep ocean fallback */}
          <rect width={MAP_W} height={MAP_H} fill="#0a1a2e" />
          {/* flattened earth — same albedo / clouds / night lights as the globe */}
          <image
            href={basemap ?? earthDay}
            x={0}
            y={0}
            width={MAP_W}
            height={MAP_H}
            preserveAspectRatio="none"
          />
          {/* atmospheric limb, matching the globe's halo */}
          <rect width={MAP_W} height={MAP_H} fill="url(#map-atmos)" pointerEvents="none" />

          {/* graticule */}
          <g stroke="#dbeafe" strokeOpacity={0.08} strokeWidth={0.5 * inv}>
            {Array.from({ length: 11 }, (_, i) => (i + 1) * (MAP_W / 12)).map((x) => (
              <line key={`v${x}`} x1={x} y1={0} x2={x} y2={MAP_H} />
            ))}
            {Array.from({ length: 5 }, (_, i) => (i + 1) * (MAP_H / 6)).map((y) => (
              <line key={`h${y}`} x1={0} y1={y} x2={MAP_W} y2={y} />
            ))}
          </g>
          <line
            x1={0}
            y1={MAP_H / 2}
            x2={MAP_W}
            y2={MAP_H / 2}
            stroke="#e2e8f0"
            strokeOpacity={0.16}
            strokeWidth={0.6 * inv}
            strokeDasharray={`${6 * inv} ${6 * inv}`}
          />

        {/* weather cells — smooth heat-map gradients, low opacity */}
        {layers.weather &&
          profile.weather.map((c) => {
            const p = project(c.lat, c.lon);
            const color = WEATHER_COLOR[c.kind];
            const r = 12 + c.size * 90;
            const grad = c.kind === 'STORM' ? 'wx-storm' : c.kind === 'RAIN' ? 'wx-rain' : 'wx-cloud';
            return (
              <g key={c.id} pointerEvents="none">
                {/* broad atmospheric wash */}
                <circle cx={p.x} cy={p.y} r={r * 1.7} fill={`url(#${grad})`} opacity={0.8}>
                  <animate
                    attributeName="r"
                    values={`${r * 1.7};${r * 1.82};${r * 1.7}`}
                    dur="6s"
                    repeatCount="indefinite"
                  />
                </circle>
                {/* dense core */}
                <circle cx={p.x} cy={p.y} r={r * 0.75} fill={`url(#${grad})`} opacity={0.55 + c.severity / 400} />
                <g transform={`translate(${p.x} ${p.y - r * 0.75 - 5}) scale(${inv})`}>
                  <text
                    textAnchor="middle"
                    fill={color}
                    fillOpacity={0.8}
                    fontSize={6}
                    letterSpacing={1}
                    className="font-mono uppercase"
                  >
                    {c.kind} {c.severity}
                  </text>
                </g>
              </g>
            );
          })}

        {/* operational regions */}
        {REGIONS.map((rg) => {
          const p = project(rg.lat, rg.lon);
          const active = activeRegion === rg.name;
          return (
            <g key={rg.id} opacity={active ? 1 : 0.55}>
              <rect
                x={p.x - 46}
                y={p.y - 30}
                width={92}
                height={60}
                rx={6}
                fill={active ? '#38bdf8' : '#94a3b8'}
                fillOpacity={active ? 0.06 : 0.025}
                stroke={active ? '#38bdf8' : '#64748b'}
                strokeOpacity={active ? 0.55 : 0.28}
                strokeWidth={0.7 * inv}
                strokeDasharray={`${3 * inv} ${4 * inv}`}
              />
              <g transform={`translate(${p.x - 44} ${p.y - 34}) scale(${inv})`}>
                <text
                  fill={active ? '#bae6fd' : '#94a3b8'}
                  fontSize={7}
                  letterSpacing={1.6}
                  className="font-mono uppercase"
                >
                  {rg.name}
                </text>
              </g>
            </g>
          );
        })}

        {/* communication links */}
        {layers.routes &&
          visibleLinks.map((l) => {
            const pts = pairPoints(l.segment.from, l.segment.to);
            if (!pts) return null;
            const onRoute = routeIds.has(l.segment.id);
            const isSelected = selectedLink === l.segment.id;
            const color = onRoute ? STATUS_META[l.status].color : TECH_META[l.segment.tech].color;
            const d = arcPath(pts.a, pts.b);
            return (
              <g
                key={l.segment.id}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  state.select({ type: 'link', id: l.segment.id });
                }}
              >
                <path d={d} stroke="transparent" strokeWidth={8 * inv} fill="none" />
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={(isSelected ? 2.2 : onRoute ? 1.6 : 0.8) * inv}
                  strokeOpacity={isSelected ? 1 : onRoute ? 0.9 : 0.32}
                  strokeDasharray={l.status === 'UNAVAILABLE' ? `${3 * inv} ${5 * inv}` : undefined}
                />
                {(onRoute || isSelected) && l.status !== 'UNAVAILABLE' && (
                  <path
                    d={d}
                    fill="none"
                    stroke="#e0f2fe"
                    strokeWidth={1.4 * inv}
                    strokeOpacity={0.85}
                    strokeDasharray={`${5 * inv} ${26 * inv}`}
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from={31 * inv}
                      to="0"
                      dur="1.1s"
                      repeatCount="indefinite"
                    />
                  </path>
                )}
              </g>
            );
          })}

        {/* assets */}
        {ASSETS.map((a: Asset) => {
          const p = pointOf(a.id);
          if (!p) return null;
          const color = KIND_COLOR[a.kind];
          const isSelected = selectedAsset === a.id;
          const onRoute = profile.route.includes(a.id);
          return (
            <g
              key={a.id}
              transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${inv})`}
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                state.select({ type: 'asset', id: a.id });
              }}
            >
              <circle r={11} fill="transparent" />
              {(isSelected || onRoute) && (
                <circle
                  r={isSelected ? 11 : 8}
                  fill="none"
                  stroke={isSelected ? '#e0f2fe' : color}
                  strokeOpacity={isSelected ? 0.9 : 0.5}
                  strokeWidth={isSelected ? 1.1 : 0.7}
                >
                  {isSelected && (
                    <animate attributeName="r" values="11;14;11" dur="2.2s" repeatCount="indefinite" />
                  )}
                </circle>
              )}
              <NodeGlyph kind={a.kind} color={a.health === 'DEGRADED' ? '#fbbf24' : color} />
              {layers.labels && (
                <text
                  x={0}
                  y={LABEL_DY[a.kind]}
                  textAnchor="middle"
                  fill={isSelected ? '#e0f2fe' : '#cbd5e1'}
                  fillOpacity={isSelected ? 1 : 0.62}
                  fontSize={6}
                  letterSpacing={0.8}
                  className="font-mono uppercase"
                >
                  {a.name}
                </text>
              )}
            </g>
          );
        })}

        </g>
        </g>


        <rect width={MAP_W} height={MAP_H} fill="url(#map-vignette)" pointerEvents="none" />
      </svg>

      {/* quick weather overlay toggle */}
      <button
        type="button"
        onClick={() => state.toggleLayer('weather')}
        className={cn(
          'absolute right-4 bottom-[70px] rounded-[10px] border px-3 py-2 font-mono text-[9px] uppercase tracking-[0.2em] backdrop-blur-md transition-colors',
          layers.weather
            ? 'border-sky-300/25 bg-sky-400/10 text-sky-200/90 hover:bg-sky-400/20'
            : 'border-white/[0.07] bg-[#070b14]/72 text-foreground/50 hover:text-foreground/80'
        )}
      >
        {layers.weather ? 'Weather · on' : 'Weather · off'}
      </button>

      {/* map-mode readout — operational clarity for routing */}
      <div className="pointer-events-none absolute bottom-[70px] left-4 rounded-[10px] border border-white/[0.07] bg-[#070b14]/72 px-3 py-2 backdrop-blur-md">
        <p className="font-mono text-[8px] uppercase tracking-[0.26em] text-sky-200/80">
          Operational map · {profile.systemMode}
        </p>
        <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-foreground/70">
          Route {profile.route.length} hops · {telemetry.latency} ms ·{' '}
          {telemetry.bandwidth.toFixed(2)} Gbps
        </p>
        <p
          className={cn(
            'mt-0.5 font-mono text-[9px] uppercase tracking-[0.16em]',
            profile.severity > 60 ? 'text-rose-300' : 'text-emerald-300'
          )}
        >
          {profile.short} · AI {profile.ai.action}
        </p>
      </div>
    </div>
  );
}
