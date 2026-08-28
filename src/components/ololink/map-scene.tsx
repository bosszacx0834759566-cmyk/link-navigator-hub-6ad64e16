'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import earthMap from '@/assets/earth-map.jpg';
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

  const pointOf = (id: string) => {
    const ll = positions[id];
    const asset = ASSET_BY_ID[id];
    if (!ll || !asset) return null;
    const p = project(ll.lat, ll.lon);
    const o = PIXEL_OFFSET[asset.kind];
    return { x: p.x + o.x, y: p.y + o.y };
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
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
        onClick={() => state.select(null)}
      >
        <defs>
          <radialGradient id="map-vignette" cx="50%" cy="50%" r="72%">
            <stop offset="55%" stopColor="#03060d" stopOpacity="0" />
            <stop offset="100%" stopColor="#03060d" stopOpacity="0.92" />
          </radialGradient>
          <filter id="map-basemap">
            <feColorMatrix
              type="matrix"
              values="0.26 0.44 0.52 0 0.02
                      0.34 0.62 0.72 0 0.04
                      0.46 0.82 1.00 0 0.07
                      0    0    0    1 0"
            />
            <feComponentTransfer>
              <feFuncR type="linear" slope="1.9" intercept="0.02" />
              <feFuncG type="linear" slope="1.9" intercept="0.03" />
              <feFuncB type="linear" slope="1.9" intercept="0.05" />
            </feComponentTransfer>
          </filter>
        </defs>

        {/* ocean */}
        <rect width={MAP_W} height={MAP_H} fill="#050a14" />
        {/* landmass base */}
        <image
          href={earthMap}
          x={0}
          y={0}
          width={MAP_W}
          height={MAP_H}
          opacity={0.9}
          filter="url(#map-basemap)"
          preserveAspectRatio="none"
        />

        {/* graticule */}
        <g stroke="#38bdf8" strokeOpacity={0.07} strokeWidth={0.5}>
          {Array.from({ length: 11 }, (_, i) => (i + 1) * (MAP_W / 12)).map((x) => (
            <line key={`v${x}`} x1={x} y1={0} x2={x} y2={MAP_H} />
          ))}
          {Array.from({ length: 5 }, (_, i) => (i + 1) * (MAP_H / 6)).map((y) => (
            <line key={`h${y}`} x1={0} y1={y} x2={MAP_W} y2={y} />
          ))}
        </g>
        <line x1={0} y1={MAP_H / 2} x2={MAP_W} y2={MAP_H / 2} stroke="#38bdf8" strokeOpacity={0.16} strokeWidth={0.6} strokeDasharray="6 6" />

        {/* weather cells */}
        {layers.weather &&
          profile.weather.map((c) => {
            const p = project(c.lat, c.lon);
            const color = WEATHER_COLOR[c.kind];
            const r = 12 + c.size * 90;
            return (
              <g key={c.id}>
                <circle cx={p.x} cy={p.y} r={r} fill={color} fillOpacity={0.1 + c.severity / 700} />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.5}
                  strokeWidth={0.8}
                  strokeDasharray="4 4"
                >
                  <animate attributeName="r" values={`${r};${r * 1.08};${r}`} dur="4s" repeatCount="indefinite" />
                </circle>
                <text
                  x={p.x}
                  y={p.y - r - 4}
                  textAnchor="middle"
                  fill={color}
                  fillOpacity={0.75}
                  fontSize={6}
                  letterSpacing={1}
                  className="font-mono uppercase"
                >
                  {c.kind} {c.severity}
                </text>
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
                strokeWidth={0.7}
                strokeDasharray="3 4"
              />
              <text
                x={p.x - 44}
                y={p.y - 34}
                fill={active ? '#bae6fd' : '#94a3b8'}
                fontSize={7}
                letterSpacing={1.6}
                className="font-mono uppercase"
              >
                {rg.name}
              </text>
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
                <path d={d} stroke="transparent" strokeWidth={8} fill="none" />
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={isSelected ? 2.2 : onRoute ? 1.6 : 0.8}
                  strokeOpacity={isSelected ? 1 : onRoute ? 0.9 : 0.32}
                  strokeDasharray={l.status === 'UNAVAILABLE' ? '3 5' : undefined}
                />
                {(onRoute || isSelected) && l.status !== 'UNAVAILABLE' && (
                  <path
                    d={d}
                    fill="none"
                    stroke="#e0f2fe"
                    strokeWidth={1.4}
                    strokeOpacity={0.85}
                    strokeDasharray="5 26"
                  >
                    <animate attributeName="stroke-dashoffset" from="31" to="0" dur="1.1s" repeatCount="indefinite" />
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
              transform={`translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`}
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

        <rect width={MAP_W} height={MAP_H} fill="url(#map-vignette)" pointerEvents="none" />
      </svg>

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
