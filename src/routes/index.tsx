import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import { useOloLink } from '@/hooks/use-ololink';
import { TopNav } from '@/components/ololink/top-nav';
import { ContextPanel } from '@/components/ololink/context-panel';
import { ObjectCard } from '@/components/ololink/object-card';
import { Dock } from '@/components/ololink/dock';
import { ViewSwitch } from '@/components/ololink/view-switch';

const MapScene = lazy(() =>
  import('@/components/ololink/map-scene').then((m) => ({ default: m.MapScene }))
);

const GlobeScene = lazy(() =>
  import('@/components/ololink/globe-scene').then((m) => ({ default: m.GlobeScene }))
);

export const Route = createFileRoute('/')({
  ssr: false,
  head: () => ({
    meta: [
      { title: 'OloLink Explorer — Spatial Network Operations' },
      {
        name: 'description',
        content:
          'OloLink Explorer: a spatial operating environment for intelligent communication orchestration across LEO satellites, HAPS, relay drones and ground stations.',
      },
      { property: 'og:title', content: 'OloLink Explorer — Spatial Network Operations' },
      {
        property: 'og:description',
        content:
          'Operate the global communication network from a live 3D Earth: adaptive routing, weather intelligence and AI decisions in one spatial environment.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: Explorer,
});

function Explorer() {
  const state = useOloLink();

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black text-foreground">
      {/* LEVEL 1 — spatial environment */}
      <div className="absolute inset-0">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <span className="animate-pulse font-mono text-[10px] uppercase tracking-[0.3em] text-sky-400/70">
                Initialising spatial environment
              </span>
            </div>
          }
        >
          <AnimatePresence mode="wait" initial={false}>
            {state.view === '3d' ? (
              <motion.div
                key="view-3d"
                className="absolute inset-0"
                initial={{ opacity: 0, scale: 1.06, filter: 'blur(6px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 1.06, filter: 'blur(6px)' }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              >
                <GlobeScene state={state} />
              </motion.div>
            ) : (
              <motion.div
                key="view-2d"
                className="absolute inset-0"
                initial={{ opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              >
                <MapScene state={state} />
              </motion.div>
            )}
          </AnimatePresence>
        </Suspense>
      </div>


      {/* LEVEL 2 — top navigation */}
      <TopNav
        active={state.panel}
        onToggle={state.togglePanel}
        alertCount={state.profile.alerts.length}
      />

      {/* view mode — same mission state, different projection */}
      <ViewSwitch view={state.view} onChange={state.setView} />

      {/* LEVEL 3 — contextual side panel */}
      <ContextPanel state={state} />

      {/* LEVEL 4 — object-specific information */}
      <ObjectCard state={state} />

      {/* compact command dock */}
      <Dock state={state} />

    </div>
  );
}
