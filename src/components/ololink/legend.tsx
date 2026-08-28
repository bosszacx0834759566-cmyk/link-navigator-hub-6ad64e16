'use client';

import { KIND_META, TECH_META, type AssetKind, type Tech } from '@/lib/ololink';

const KIND_COLOR: Record<AssetKind, string> = {
  satellite: '#7dd3fc',
  haps: '#38bdf8',
  drone: '#a5b4fc',
  ground: '#34d399',
  customer: '#e2e8f0',
};

const KIND_ORDER: AssetKind[] = ['satellite', 'haps', 'drone', 'ground', 'customer'];
const TECH_ORDER: Tech[] = ['OPTICAL', 'FSO', 'MICROWAVE', 'RF', 'FIBER'];

/** Tiny SVG glyphs echoing the 3D marker silhouettes. */
function Glyph({ kind, color }: { kind: AssetKind; color: string }) {
  const common = { stroke: color, fill: 'none', strokeWidth: 1.2 };
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0">
      {kind === 'satellite' && (
        <g {...common}>
          <rect x="6.5" y="6" width="3" height="4" fill={color} />
          <rect x="1.5" y="6.8" width="4" height="2.4" />
          <rect x="10.5" y="6.8" width="4" height="2.4" />
          <path d="M8 10.5 L6.5 13.5 M8 10.5 L9.5 13.5" />
        </g>
      )}
      {kind === 'haps' && (
        <g {...common}>
          <ellipse cx="8" cy="6.5" rx="6.2" ry="1.7" fill={color} fillOpacity={0.35} />
          <path d="M5 8.2 v2.2 M11 8.2 v2.2" />
          <path d="M2.5 12.6 h11" strokeOpacity={0.45} />
        </g>
      )}
      {kind === 'drone' && (
        <g {...common}>
          <rect x="6.6" y="6.6" width="2.8" height="2.8" fill={color} />
          <path d="M3 3 L13 13 M13 3 L3 13" strokeOpacity={0.6} />
          <circle cx="3" cy="3" r="1.6" />
          <circle cx="13" cy="3" r="1.6" />
          <circle cx="3" cy="13" r="1.6" />
          <circle cx="13" cy="13" r="1.6" />
        </g>
      )}
      {kind === 'ground' && (
        <g {...common}>
          <path d="M4.5 8.5 A4 4 0 0 1 12 5.6 L8.4 9.4 Z" fill={color} fillOpacity={0.4} />
          <path d="M8 9.4 v3.2" />
          <path d="M4 13.4 h8" />
        </g>
      )}
      {kind === 'customer' && (
        <g {...common}>
          <circle cx="8" cy="8" r="5" strokeOpacity={0.7} />
          <rect x="6.4" y="6.4" width="3.2" height="3.2" fill={color} />
          <circle cx="8" cy="3" r="1" fill={color} />
          <circle cx="13" cy="8" r="1" fill={color} />
          <circle cx="3" cy="8" r="1" fill={color} />
          <circle cx="8" cy="13" r="1" fill={color} />
        </g>
      )}
    </svg>
  );
}

function TechGlyph({ tech }: { tech: Tech }) {
  const { color, family } = TECH_META[tech];
  return (
    <svg viewBox="0 0 26 8" className="h-2 w-6 shrink-0">
      {family === 'optical' && (
        <g stroke={color} strokeWidth={1.6}>
          <path d="M0 4 h26" />
          <circle cx="17" cy="4" r="1.6" fill="#f0f9ff" stroke="none" />
        </g>
      )}
      {family === 'radio' && (
        <g stroke={color} strokeWidth={1.2} fill="none">
          <path d="M0 4 q6.5 -3.6 13 0 t13 0" />
        </g>
      )}
      {family === 'fiber' && (
        <g stroke={color} strokeWidth={1.6}>
          <path d="M0 5.5 h26" strokeDasharray="0" />
        </g>
      )}
    </svg>
  );
}

export function Legend({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <div className="pointer-events-none absolute bottom-24 left-16 z-20 hidden w-[188px] rounded-lg border border-white/[0.06] bg-[#070b14]/72 p-3 backdrop-blur-md lg:block">
      <div className="text-[9px] uppercase tracking-[0.24em] text-muted-foreground/55">Infrastructure</div>
      <div className="mt-2 space-y-1.5">
        {KIND_ORDER.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <Glyph kind={k} color={KIND_COLOR[k]} />
            <span className="text-[10px] tracking-wide text-foreground/75">{KIND_META[k].label}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[9px] uppercase tracking-[0.24em] text-muted-foreground/55">Link layer</div>
      <div className="mt-2 space-y-1.5">
        {TECH_ORDER.map((t) => (
          <div key={t} className="flex items-center gap-2">
            <TechGlyph tech={t} />
            <span className="text-[10px] tracking-wide text-foreground/75">{TECH_META[t].short}</span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 26 8" className="h-2 w-6 shrink-0">
            <path d="M0 4 h26" stroke="#fb7185" strokeWidth={1.4} strokeDasharray="3 3" />
          </svg>
          <span className="text-[10px] tracking-wide text-foreground/60">Blocked</span>
        </div>
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 26 8" className="h-2 w-6 shrink-0">
            <path d="M0 4 h26" stroke="#94a3b8" strokeWidth={1.2} strokeDasharray="5 4" opacity={0.5} />
          </svg>
          <span className="text-[10px] tracking-wide text-foreground/60">Standby</span>
        </div>
      </div>
    </div>
  );
}
