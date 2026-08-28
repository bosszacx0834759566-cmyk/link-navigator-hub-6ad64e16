'use client';

import { Canvas, useFrame, useLoader, type ThreeEvent } from '@react-three/fiber';
import { createPortal } from 'react-dom';
import { Html, OrbitControls, Stars } from '@react-three/drei';
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';

import earthDay from '@/assets/earth_atmos_2048.jpg';
import earthNight from '@/assets/earth_lights_2048.png';
import earthClouds from '@/assets/earth_clouds_1024.png';
import earthSpec from '@/assets/earth_specular_2048.jpg';
import {
  ASSET_BY_ID,
  ASSETS,
  TECH_META,
  geoToVec,
  routeSegments,
  type Asset,
  type LinkState,
  type ScenarioProfile,
  type Segment,
  type WeatherCell,
} from '@/lib/ololink';
import type { OloLinkState, Selection } from '@/hooks/use-ololink';
import { LabelLayer, LabelProjector, useLabel } from '@/components/ololink/label-layer';
import {
  CAMERA_PRESETS,
  OPERATIONAL_VIEW,
  fitView,
  pointView,
  presetView,
  stationInto,
  type CameraView,
  type PresetId,
} from '@/lib/camera-presets';
import {
  LAYER,
  LAYER_STACK,
  LOD_LABEL,
  REGIONS,
  REGION_BY_ID,
  assetVec,
  geoOnShell,
  layerRadius,
  lodForDistance,
  regionIdOf,
  type LodLevel,
  type RegionDef,
} from '@/lib/layers';
import {
  DOWNLINK_TARGETS,
  SAT_ORBITS,
  SATELLITES,
  orbitPosition,
  orbitTangent,
  staticPosition,
  windowScore,
} from '@/lib/orbits';

/** Live scene positions for every asset — satellites are updated every frame. */
type LiveMap = Map<string, THREE.Vector3>;

function createLiveMap(): LiveMap {
  return new Map(ASSETS.map((a) => [a.id, staticPosition(a)]));
}

const CYAN = '#38bdf8';
const UP = new THREE.Vector3(0, 1, 0);

function vec(a: Asset) {
  return new THREE.Vector3(...assetVec(a));
}

/* --------------------------------------------------- level-of-detail ctx */

interface LodState {
  level: LodLevel;
  /** region the camera is currently looking at, if any */
  region: string | null;
}

const LodContext = createContext<LodState>({ level: 'global', region: null });
const useLod = () => useContext(LodContext);

/** Watches the camera and derives view level + focused region. */
function LodDriver({ onChange }: { onChange: (s: LodState) => void }) {
  const last = useRef<LodState>({ level: 'global', region: null });
  const dir = useRef(new THREE.Vector3());
  const normals = useMemo(
    () =>
      REGIONS.map((r) => ({
        id: r.id,
        n: new THREE.Vector3(...geoOnShell(r.lat, r.lon, 1)).normalize(),
      })),
    []
  );

  useFrame(({ camera }) => {
    const d = camera.position.length();
    const level = lodForDistance(d);
    dir.current.copy(camera.position).normalize();
    let region: string | null = null;
    let best = 0.62;
    for (const r of normals) {
      const dot = r.n.dot(dir.current);
      if (dot > best) {
        best = dot;
        region = r.id;
      }
    }
    if (level === 'global') region = null;
    if (last.current.level !== level || last.current.region !== region) {
      last.current = { level, region };
      onChange(last.current);
    }
  });
  return null;
}

/** Smoothly fades a group in/out so LOD changes never pop. */
function Fade({
  show,
  speed = 3.2,
  children,
}: {
  show: boolean;
  speed?: number;
  children: React.ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const v = useRef(show ? 1 : 0);
  const mounted = useRef(show);
  const [alive, setAlive] = useState(show);

  useFrame((_, d) => {
    const g = group.current;
    v.current += ((show ? 1 : 0) - v.current) * Math.min(1, d * speed);
    if (!g) return;
    const a = v.current;
    g.visible = a > 0.015;
    g.scale.setScalar(0.92 + a * 0.08);
    g.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      const apply = (mm: THREE.Material) => {
        const anyM = mm as THREE.Material & { userData: { base?: number }; opacity: number };
        if (anyM.userData.base === undefined) anyM.userData.base = anyM.opacity;
        anyM.transparent = true;
        anyM.opacity = anyM.userData.base * a;
      };
      Array.isArray(m) ? m.forEach(apply) : apply(m);
    });
    if (!show && a < 0.02 && mounted.current) {
      mounted.current = false;
      setAlive(false);
    } else if (show && !mounted.current) {
      mounted.current = true;
      setAlive(true);
    }
  });

  useEffect(() => {
    if (show) {
      mounted.current = true;
      setAlive(true);
    }
  }, [show]);

  if (!alive && !show) return null;
  return <group ref={group}>{children}</group>;
}

/** Quaternion that stands an object up on the sphere surface. */
function surfaceQuat(position: THREE.Vector3) {
  return new THREE.Quaternion().setFromUnitVectors(UP, position.clone().normalize());
}

const LIFT: Record<'optical' | 'radio' | 'fiber', number> = {
  optical: 0.05,
  radio: 0.34,
  fiber: 0.006,
};

function curveFor(from: Asset, to: Asset, family: 'optical' | 'radio' | 'fiber') {
  const a = vec(from);
  const b = vec(to);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const lift = 1 + a.distanceTo(b) * LIFT[family];
  mid.setLength(Math.max(a.length(), b.length()) * lift);
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

function curveForSegment(segment: Segment) {
  const from = ASSET_BY_ID[segment.from]!;
  const to = ASSET_BY_ID[segment.to]!;
  return curveFor(from, to, TECH_META[segment.tech].family);
}

/* ---------------------------------------------------------------- Earth */

/** Direction of the sun — chosen so the terminator crosses both regions. */
export const SUN_DIR = new THREE.Vector3(...geoToVec(14, 178, 0)).normalize();

function Earth() {
  const maps = useLoader(THREE.TextureLoader, [earthDay, earthNight, earthClouds, earthSpec]);
  const day = maps[0]!;
  const night = maps[1]!;
  const clouds = maps[2]!;
  const spec = maps[3]!;
  day.colorSpace = THREE.SRGBColorSpace;
  night.colorSpace = THREE.SRGBColorSpace;

  const cloudRef = useRef<THREE.Mesh>(null);
  useFrame((_, d) => {
    if (cloudRef.current) cloudRef.current.rotation.y += d * 0.004;
  });

  return (
    <group>
      {/* realistic surface: satellite albedo, sun-lit */}
      <mesh>
        <sphereGeometry args={[1, 128, 128]} />
        <meshStandardMaterial
          map={day}
          roughnessMap={spec}
          metalness={0.05}
          roughness={0.82}
          color="#e6eef5"
        />
      </mesh>
      {/* city lights — additive, masked to the night hemisphere only */}
      <mesh scale={1.001}>
        <sphereGeometry args={[1, 96, 96]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          uniforms={{ uMap: { value: night }, uSun: { value: SUN_DIR } }}
          vertexShader={`
            varying vec2 vUv; varying vec3 vN;
            void main() {
              vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }`}
          fragmentShader={`
            uniform sampler2D uMap; uniform vec3 uSun;
            varying vec2 vUv; varying vec3 vN;
            void main() {
              float nightMask = smoothstep(0.12, -0.22, dot(vN, normalize(uSun)));
              vec3 c = texture2D(uMap, vUv).rgb;
              gl_FragColor = vec4(c * vec3(1.0, 0.82, 0.55) * nightMask * 0.9, 1.0);
            }`}
        />
      </mesh>

      {/* cloud layer */}
      <mesh ref={cloudRef} scale={1.006}>
        <sphereGeometry args={[1, 96, 96]} />
        <meshStandardMaterial
          map={clouds}
          alphaMap={clouds}
          transparent
          opacity={0.42}
          depthWrite={false}
          color="#dfe7ee"
          roughness={1}
        />
      </mesh>
      {/* inner atmosphere */}
      <mesh>
        <sphereGeometry args={[1.016, 64, 64]} />
        <meshBasicMaterial color="#4a86c8" transparent opacity={0.07} side={THREE.BackSide} />
      </mesh>
      {/* outer halo */}
      <mesh>
        <sphereGeometry args={[1.08, 64, 64]} />
        <meshBasicMaterial color="#1d4e8f" transparent opacity={0.06} side={THREE.BackSide} />
      </mesh>
    </group>
  );
}


/* --------------------------------------------- orbital trajectory rings */
/* Deliberately near-invisible: these are mechanics, not communication. */

function OrbitTrack({ elId }: { elId: string }) {
  const geometry = useMemo(() => {
    const el = SAT_ORBITS[elId]!;
    const pts = Array.from({ length: 181 }, (_, i) => {
      const a = (i / 180) * Math.PI * 2;
      return el.e1
        .clone()
        .multiplyScalar(Math.cos(a) * el.radius)
        .addScaledVector(el.e2, Math.sin(a) * el.radius);
    });
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    g.computeBoundingSphere();
    return g;
  }, [elId]);
  return (
    // @ts-expect-error three line primitive
    <line geometry={geometry}>
      <lineBasicMaterial color="#7dd3fc" transparent opacity={0.06} depthWrite={false} />
    </line>
  );
}

/**
 * Propagates the visual LEO model and evaluates communication windows.
 * Concept simulation only — circular paths, accelerated rates.
 */
function OrbitDriver({ state, live }: { state: OloLinkState; live: LiveMap }) {
  const acc = useRef(0);
  const tmp = useRef(new THREE.Vector3());

  useFrame(({ clock }, d) => {
    const t = clock.elapsedTime;
    for (const sat of SATELLITES) {
      const el = SAT_ORBITS[sat.id];
      const target = live.get(sat.id);
      if (el && target) orbitPosition(el, t, target);
    }

    if (!state.running) return;
    acc.current += d;
    if (acc.current < 0.5) return;
    acc.current = 0;

    for (const rx of DOWNLINK_TARGETS) {
      const receiver = live.get(rx.id);
      if (!receiver) continue;
      let bestId: string | null = null;
      let best = 0;
      for (const satId of rx.sats) {
        const pos = live.get(satId);
        if (!pos) continue;
        const score = windowScore(tmp.current.copy(pos), receiver);
        if (score > best) {
          best = score;
          bestId = satId;
        }
      }
      // hysteresis: hold an acquired link until the window really closes
      const held = state.windows[rx.id] ?? null;
      if (held && held !== bestId) {
        const heldPos = live.get(held);
        if (heldPos && windowScore(tmp.current.copy(heldPos), receiver) > 0.18) continue;
      }
      state.reportWindow(rx.id, best > 0.24 ? bestId : null);
    }
  });

  return null;
}

/* --------------------------------------------------- link helper meshes */

function usePoints(curve: THREE.Curve<THREE.Vector3>, count = 72) {
  return useMemo(() => curve.getPoints(count), [curve, count]);
}

function SolidLine({
  points,
  color,
  opacity,
}: {
  points: THREE.Vector3[];
  color: string;
  opacity: number;
}) {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);
  return (
    // @ts-expect-error three line primitive
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </line>
  );
}

/** Interrupted stroke — used for blocked / unavailable paths. */
function DashedLine({
  points,
  color,
  opacity,
  dash = 0.02,
  gap = 0.03,
}: {
  points: THREE.Vector3[];
  color: string;
  opacity: number;
  dash?: number;
  gap?: number;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    return g;
  }, [points]);
  const ref = useRef<THREE.Object3D & { computeLineDistances?: () => void }>(null);
  useEffect(() => {
    (ref.current as unknown as THREE.Line | null)?.computeLineDistances();
  }, [geometry]);
  return (
    // @ts-expect-error three line primitive
    <line ref={ref} geometry={geometry}>
      <lineDashedMaterial
        color={color}
        transparent
        opacity={opacity}
        dashSize={dash}
        gapSize={gap}
        depthWrite={false}
      />
    </line>
  );
}

/**
 * Opportunistic pass: any LEO that flies over a receiver without a designed
 * segment still transmits a straight line-of-sight beam while overhead.
 */
function PassBeam({ satId, rxId, live }: { satId: string; rxId: string; live: LiveMap }) {
  const N = 2;
  const core = useRef<THREE.Line>(null);
  const packs = useRef<THREE.Group>(null);
  const vis = useRef(0);
  const flow = useRef(Math.random());

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    return g;
  }, []);

  const scratch = useMemo(
    () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), p: new THREE.Vector3() }),
    []
  );

  useFrame((_, d) => {
    const from = live.get(satId);
    const to = live.get(rxId);
    if (!from || !to) return;
    const { a, b, p } = scratch;
    a.copy(from);
    b.copy(to);

    const target = windowScore(a, b) > 0.2 ? 1 : 0;
    vis.current += (target - vis.current) * Math.min(1, d * 1.8);
    flow.current = (flow.current + d * 0.5) % 1;

    const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i <= N; i++) {
      p.copy(a).lerp(b, i / N);
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    }
    attr.needsUpdate = true;

    const v = vis.current;
    if (core.current) {
      const m = core.current.material as THREE.LineBasicMaterial;
      m.opacity = v * 0.6;
      core.current.visible = v > 0.01;
    }
    if (packs.current) {
      packs.current.visible = v > 0.05;
      packs.current.children.forEach((child, i) => {
        const t = (flow.current + i / packs.current!.children.length) % 1;
        child.position.copy(p.copy(a).lerp(b, t));
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = v * (0.4 + 0.6 * Math.sin(t * Math.PI)) * 0.85;
      });
    }
  });

  return (
    <group>
      {/* @ts-expect-error three line primitive */}
      <line ref={core} geometry={geometry}>
        <lineBasicMaterial
          color={CYAN}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </line>
      <group ref={packs}>
        {[0, 1, 2].map((i) => (
          <mesh key={i}>
            <sphereGeometry args={[0.004, 8, 8]} />
            <meshBasicMaterial
              color="#f0f9ff"
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}


/**
 * Live satellite downlink: geometry is re-sampled every frame from the moving
 * satellite, and the optical beam only exists inside a communication window.
 */
function DownlinkBeam({
  link,
  live,
  inWindow,
  selected,
  highlighted,
  onSelect,
}: {
  link: LinkState;
  live: LiveMap;
  inWindow: boolean;
  selected: boolean;
  highlighted: boolean;
  onSelect: (s: Selection) => void;
}) {
  const N = 40;
  const meta = TECH_META[link.segment.tech];
  const blocked = link.status === 'UNAVAILABLE';
  const degraded = link.status === 'DEGRADED';
  

  const core = useRef<THREE.Line>(null);
  const sheath = useRef<THREE.Line>(null);
  const packs = useRef<THREE.Group>(null);
  const hit = useRef<THREE.Mesh>(null);
  const vis = useRef(0);
  const flow = useRef(Math.random());

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    return g;
  }, []);

  const scratch = useMemo(
    () => ({
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      p: new THREE.Vector3(),
      q: new THREE.Vector3(),
    }),
    []
  );

  useFrame((_, d) => {
    const from = live.get(link.segment.from);
    const to = live.get(link.segment.to);
    if (!from || !to) return;

    const { a, b, p, q } = scratch;
    a.copy(from);
    b.copy(to);

    // any LEO that is actually passing over the receiver transmits — not just
    // the single best-scoring satellite
    const pass = windowScore(a, b) > 0.16;
    const target = !blocked && (pass || inWindow) ? 1 : 0;
    vis.current += (target - vis.current) * Math.min(1, d * 1.8);
    flow.current = (flow.current + d * 0.5) % 1;

    const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      // straight line-of-sight beam
      p.copy(a).lerp(b, t);
      arr[i * 3] = p.x;
      arr[i * 3 + 1] = p.y;
      arr[i * 3 + 2] = p.z;
    }
    attr.needsUpdate = true;

    const bezier = (t: number, out: THREE.Vector3) => out.copy(a).lerp(b, t);

    const boost = highlighted || selected ? 1.3 : 1;
    const v = vis.current;
    if (core.current) {
      const m = core.current.material as THREE.LineBasicMaterial;
      m.opacity = v * 0.85 * boost;
      m.color.set(degraded ? '#fcd34d' : '#e0f2fe');
      core.current.visible = v > 0.01;
    }
    if (sheath.current) {
      const m = sheath.current.material as THREE.LineBasicMaterial;
      // faint standby trace stays when the window is closed
      m.opacity = blocked ? 0.05 : 0.05 + v * 0.35 * boost;
      m.color.set(blocked ? '#fb7185' : degraded ? '#fbbf24' : meta.color);
    }
    if (packs.current) {
      packs.current.visible = v > 0.05;
      packs.current.children.forEach((child, i) => {
        const t = (flow.current + i / packs.current!.children.length) % 1;
        child.position.copy(bezier(t, q));
        const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        mat.opacity = v * (0.5 + 0.5 * Math.sin(t * Math.PI)) * 0.95;
      });
    }
    if (hit.current) hit.current.position.copy(bezier(0.5, q));
  });

  return (
    <group>
      {/* @ts-expect-error three line primitive */}
      <line ref={sheath} geometry={geometry}>
        <lineBasicMaterial
          color={meta.color}
          transparent
          opacity={0.06}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </line>
      {/* @ts-expect-error three line primitive */}
      <line ref={core} geometry={geometry}>
        <lineBasicMaterial
          color="#e0f2fe"
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </line>
      <group ref={packs}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i}>
            <sphereGeometry args={[0.0045, 8, 8]} />
            <meshBasicMaterial
              color="#f0f9ff"
              transparent
              opacity={0}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        ))}
      </group>
      <mesh
        ref={hit}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect({ type: 'link', id: link.segment.id });
        }}
      >
        <sphereGeometry args={[0.018, 8, 8]} />
        <meshBasicMaterial
          color={meta.color}
          transparent
          opacity={selected ? 0.22 : 0.02}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Focused laser beam: taut, additive, with fast travelling photon packets. */
function OpticalBeam({
  curve,
  color,
  strength,
}: {
  curve: THREE.Curve<THREE.Vector3>;
  color: string;
  strength: number;
}) {
  const packs = useRef<THREE.Group>(null);
  const offsets = useMemo(() => [0, 0.34, 0.67], []);
  const t = useRef(Math.random());

  useFrame((_, d) => {
    t.current = (t.current + d * 0.55) % 1;
    if (!packs.current) return;
    packs.current.children.forEach((child, i) => {
      const p = (t.current + offsets[i]!) % 1;
      const pt = curve.getPointAt(p);
      child.position.copy(pt);
      const ahead = curve.getPointAt(Math.min(0.999, p + 0.02));
      child.lookAt(ahead);
    });
  });

  return (
    <group>
      {/* hard core */}
      <mesh>
        <tubeGeometry args={[curve, 48, 0.0022, 6, false]} />
        <meshBasicMaterial
          color="#e0f2fe"
          transparent
          opacity={0.75 * strength}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* glow sheath */}
      <mesh>
        <tubeGeometry args={[curve, 48, 0.008, 8, false]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.22 * strength}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <group ref={packs}>
        {offsets.map((o) => (
          <mesh key={o}>
            <cylinderGeometry args={[0.0035, 0.0035, 0.05, 6]} />
            <meshBasicMaterial
              color="#f0f9ff"
              transparent
              opacity={0.9 * strength}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Radio / microwave: bowed corridor carrying expanding wavefronts. */
function RadioWave({
  curve,
  color,
  strength,
}: {
  curve: THREE.Curve<THREE.Vector3>;
  color: string;
  strength: number;
}) {
  const points = usePoints(curve, 64);
  const rings = useRef<THREE.Group>(null);
  const offsets = useMemo(() => [0, 0.25, 0.5, 0.75], []);
  const t = useRef(Math.random());

  useFrame((_, d) => {
    t.current = (t.current + d * 0.24) % 1;
    if (!rings.current) return;
    rings.current.children.forEach((child, i) => {
      const p = (t.current + offsets[i]!) % 1;
      child.position.copy(curve.getPointAt(p));
      const tan = curve.getTangentAt(p);
      child.lookAt(child.position.clone().add(tan));
      const s = 0.6 + Math.sin(p * Math.PI) * 1.4;
      child.scale.setScalar(s);
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.sin(p * Math.PI) * 0.7 * strength;
    });
  });

  return (
    <group>
      <SolidLine points={points} color={color} opacity={0.5 * strength} />
      <mesh>
        <tubeGeometry args={[curve, 40, 0.014, 8, false]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.07 * strength}
          depthWrite={false}
        />
      </mesh>
      <group ref={rings}>
        {offsets.map((o) => (
          <mesh key={o}>
            <torusGeometry args={[0.014, 0.0022, 6, 24]} />
            <meshBasicMaterial color={color} transparent opacity={0.5} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** Terrestrial fiber: steady surface-hugging conduit. */
function FiberRun({
  curve,
  color,
  strength,
}: {
  curve: THREE.Curve<THREE.Vector3>;
  color: string;
  strength: number;
}) {
  const pulse = useRef<THREE.Mesh>(null);
  const t = useRef(Math.random());
  useFrame((_, d) => {
    t.current = (t.current + d * 0.4) % 1;
    if (pulse.current) pulse.current.position.copy(curve.getPointAt(t.current));
  });
  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 32, 0.0035, 6, false]} />
        <meshBasicMaterial color={color} transparent opacity={0.8 * strength} depthWrite={false} />
      </mesh>
      <mesh ref={pulse}>
        <sphereGeometry args={[0.007, 10, 10]} />
        <meshBasicMaterial color="#d1fae5" transparent opacity={0.9 * strength} />
      </mesh>
    </group>
  );
}

/* ---------------------------------------------------------------- links */

function LinkPath({
  link,
  selected,
  onRoute,
  highlighted,
  onSelect,
}: {
  link: LinkState;
  selected: boolean;
  onRoute: boolean;
  highlighted: boolean;
  onSelect: (s: Selection) => void;
}) {
  const meta = TECH_META[link.segment.tech];
  const curve = useMemo(() => curveForSegment(link.segment), [link.segment]);
  const points = usePoints(curve, 64);
  const active = link.status === 'ACTIVE';
  const degraded = link.status === 'DEGRADED';
  const rerouting = link.status === 'REROUTING';
  const blocked = link.status === 'UNAVAILABLE';
  const strength = highlighted || selected ? 1.35 : onRoute ? 1 : 0.75;

  return (
    <group>
      {active || rerouting || degraded ? (
        <group>
          {meta.family === 'optical' ? (
            <OpticalBeam
              curve={curve}
              color={rerouting ? '#e0f2fe' : degraded ? '#fbbf24' : meta.color}
              strength={degraded ? strength * 0.55 : strength}
            />
          ) : meta.family === 'fiber' ? (
            <FiberRun curve={curve} color={rerouting ? '#e0f2fe' : meta.color} strength={strength} />
          ) : (
            <RadioWave
              curve={curve}
              color={rerouting ? '#e0f2fe' : degraded ? '#fbbf24' : meta.color}
              strength={degraded ? strength * 0.6 : strength}
            />
          )}
          {degraded && (
            <DashedLine points={points} color="#fbbf24" opacity={0.32} dash={0.04} gap={0.03} />
          )}
        </group>
      ) : blocked ? (
        <group>
          <DashedLine points={points} color="#fb7185" opacity={selected ? 0.45 : 0.2} />
          <mesh position={curve.getPointAt(0.5)}>
            <sphereGeometry args={[0.006, 8, 8]} />
            <meshBasicMaterial color="#fb7185" transparent opacity={selected ? 0.8 : 0.35} />
          </mesh>
        </group>
      ) : (
        <DashedLine
          points={points}
          color={meta.color}
          opacity={selected ? 0.4 : 0.1}
          dash={0.05}
          gap={0.05}
        />

      )}

      {/* generous click target */}
      <mesh
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect({ type: 'link', id: link.segment.id });
        }}
      >
        <tubeGeometry args={[curve, 24, 0.016, 6, false]} />
        <meshBasicMaterial
          color={meta.color}
          transparent
          opacity={selected ? 0.16 : 0.01}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/* -------------------------------------------- route reveal / route ghost */

function ProgressiveRoute({
  segments,
  seq,
  mode,
  color,
}: {
  segments: Segment[];
  seq: number;
  mode: 'in' | 'out';
  color: string;
}) {
  const geometries = useMemo(
    () =>
      segments.map((s) => {
        const pts = curveForSegment(s).getPoints(64);
        return new THREE.BufferGeometry().setFromPoints(pts);
      }),
    [segments]
  );
  const group = useRef<THREE.Group>(null);
  const t = useRef(0);

  useEffect(() => {
    t.current = 0;
  }, [seq, segments]);

  useFrame((_, d) => {
    t.current = Math.min(1, t.current + d / (mode === 'in' ? 1.5 : 2.6));
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, i) => {
      const line = child as THREE.Line;
      const total = 65;
      const span = 1 / Math.max(1, geometries.length);
      const local = Math.min(1, Math.max(0, (t.current - i * span) / span));
      const mat = line.material as THREE.LineBasicMaterial;
      if (mode === 'in') {
        line.geometry.setDrawRange(0, Math.round(total * local));
        mat.opacity = local * (1 - Math.max(0, t.current - 0.75) * 3.4) * 0.95;
      } else {
        line.geometry.setDrawRange(0, total);
        mat.opacity = Math.max(0, 0.5 * (1 - t.current));
      }
    });
  });

  return (
    <group ref={group}>
      {geometries.map((g, i) => (
        // @ts-expect-error three line primitive
        <line key={i} geometry={g}>
          <lineBasicMaterial
            color={color}
            transparent
            opacity={0}
            depthWrite={false}
            {...(mode === 'in' ? { blending: THREE.AdditiveBlending } : {})}
          />
        </line>
      ))}
    </group>
  );
}

/* -------------------------------------------------------- asset markers */

const KIND_COLOR: Record<Asset['kind'], string> = {
  satellite: '#7dd3fc',
  haps: '#38bdf8',
  drone: '#a5b4fc',
  ground: '#34d399',
  customer: '#e2e8f0',
};

function Satellite({ s, color }: { s: number; color: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, d) => {
    if (ref.current) ref.current.rotation.y += d * 0.5;
  });
  return (
    <group ref={ref}>
      <mesh>
        <boxGeometry args={[s * 0.9, s * 0.7, s * 0.7]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {[-1, 1].map((dir) => (
        <mesh key={dir} position={[dir * s * 1.35, 0, 0]}>
          <boxGeometry args={[s * 1.6, s * 0.06, s * 0.8]} />
          <meshBasicMaterial color="#1e3a8a" />
        </mesh>
      ))}
      {/* downlink aperture */}
      <mesh position={[0, -s * 0.55, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[s * 0.35, s * 0.4, 10, 1, true]} />
        <meshBasicMaterial color={color} side={THREE.DoubleSide} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

function Haps({ s, color }: { s: number; color: string }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) {
      ref.current.rotation.y = Math.sin(clock.elapsedTime * 0.25) * 0.5;
      ref.current.position.y = Math.sin(clock.elapsedTime * 0.7) * s * 0.15;
    }
  });
  return (
    <group ref={ref}>
      {/* stratospheric wing */}
      <mesh scale={[3.1, 0.3, 0.85]}>
        <sphereGeometry args={[s * 0.62, 16, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* twin gondolas */}
      {[-1, 1].map((dir) => (
        <mesh key={dir} position={[dir * s * 0.8, -s * 0.32, 0]}>
          <capsuleGeometry args={[s * 0.11, s * 0.34, 4, 8]} />
          <meshBasicMaterial color="#bae6fd" />
        </mesh>
      ))}
      {/* tail fin */}
      <mesh position={[0, s * 0.2, -s * 0.5]}>
        <boxGeometry args={[s * 0.06, s * 0.42, s * 0.3]} />
        <meshBasicMaterial color="#bae6fd" />
      </mesh>
      {/* station-keeping footprint */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[s * 1.5, s * 0.02, 6, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.35} />
      </mesh>
    </group>
  );
}

function Drone({ s, color }: { s: number; color: string }) {
  const rotors = useRef<THREE.Group>(null);
  useFrame((_, d) => {
    if (rotors.current) rotors.current.rotation.y += d * 6;
  });
  const arms: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  return (
    <group>
      <mesh>
        <boxGeometry args={[s * 0.55, s * 0.28, s * 0.55]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {[0, Math.PI / 2].map((r) => (
        <mesh key={r} rotation={[0, r, 0]}>
          <boxGeometry args={[s * 2, s * 0.05, s * 0.07]} />
          <meshBasicMaterial color="#c7d2fe" />
        </mesh>
      ))}
      <group ref={rotors}>
        {arms.map(([x, z]) => (
          <mesh
            key={`${x}${z}`}
            position={[x * s * 0.72, s * 0.06, z * s * 0.72]}
            rotation={[Math.PI / 2, 0, 0]}
          >
            <torusGeometry args={[s * 0.34, s * 0.02, 5, 16]} />
            <meshBasicMaterial color="#e0e7ff" transparent opacity={0.85} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function GroundStation({ s, color }: { s: number; color: string }) {
  const dish = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (dish.current) dish.current.rotation.y = Math.sin(clock.elapsedTime * 0.2) * 0.7;
  });
  return (
    <group>
      {/* pad */}
      <mesh position={[0, s * 0.05, 0]}>
        <cylinderGeometry args={[s * 0.95, s * 1.05, s * 0.12, 12]} />
        <meshBasicMaterial color="#0f766e" />
      </mesh>
      <group ref={dish} position={[0, s * 0.4, 0]}>
        {/* mast */}
        <mesh position={[0, -s * 0.18, 0]}>
          <cylinderGeometry args={[s * 0.09, s * 0.11, s * 0.5, 8]} />
          <meshBasicMaterial color="#5eead4" />
        </mesh>
        {/* parabolic dish, tilted skyward */}
        <mesh rotation={[-0.75, 0, 0]}>
          <coneGeometry args={[s * 0.85, s * 0.6, 18, 1, true]} />
          <meshBasicMaterial color={color} side={THREE.DoubleSide} />
        </mesh>
        {/* feed horn */}
        <mesh position={[0, s * 0.36, s * 0.3]}>
          <sphereGeometry args={[s * 0.1, 8, 8]} />
          <meshBasicMaterial color="#ecfeff" />
        </mesh>
      </group>
    </group>
  );
}

function CustomerNode({ s, color }: { s: number; color: string }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame((_, d) => {
    if (ring.current) ring.current.rotation.z += d * 0.6;
  });
  const spokes = [0, 1, 2, 3, 4].map((i) => (i / 5) * Math.PI * 2);
  return (
    <group>
      {/* endpoint hub */}
      <mesh position={[0, s * 0.3, 0]}>
        <boxGeometry args={[s * 0.6, s * 0.6, s * 0.6]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* distribution ring with spokes */}
      <group position={[0, s * 0.08, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <mesh ref={ring}>
          <torusGeometry args={[s * 1, s * 0.045, 6, 28]} />
          <meshBasicMaterial color="#94a3b8" />
        </mesh>
        {spokes.map((a) => (
          <mesh key={a} position={[Math.cos(a) * s * 1, Math.sin(a) * s * 1, 0]}>
            <boxGeometry args={[s * 0.18, s * 0.18, s * 0.18]} />
            <meshBasicMaterial color="#cbd5e1" />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function AssetNode({
  asset,
  selected,
  onRoute,
  onSelect,
  showLabel,
  live,
  linking,
  tether,
  detail,
}: {
  asset: Asset;
  selected: boolean;
  onRoute: boolean;
  onSelect: (s: Selection) => void;
  showLabel: boolean;
  live: LiveMap;
  /** node is inside an active communication window */
  linking?: boolean;
  /** draw a plumb line down to the surface so altitude is readable */
  tether?: boolean;
  /** show the altitude-layer caption under the name */
  detail?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const position = useMemo(() => vec(asset), [asset]);
  const quat = useMemo(() => surfaceQuat(position), [position]);
  const ring = useRef<THREE.Mesh>(null);
  const body = useRef<THREE.Group>(null);
  const root = useRef<THREE.Group>(null);
  const orbiting = asset.kind === 'satellite';
  const color = selected || hover ? '#ffffff' : linking ? '#e0f2fe' : KIND_COLOR[asset.kind];

  const s =
    asset.kind === 'satellite'
      ? 0.021
      : asset.kind === 'haps'
        ? 0.018
        : asset.kind === 'drone'
          ? 0.013
          : 0.015;

  /** plumb line from the asset's shell down to the surface below it */
  const tetherGeom = useMemo(() => {
    if (!tether || asset.altKm <= 0) return null;
    const top = new THREE.Vector3(0, 0, 0);
    const bottom = new THREE.Vector3(0, -(layerRadius(asset) - 1), 0);
    return new THREE.BufferGeometry().setFromPoints([top, bottom]);
  }, [tether, asset]);

  useFrame(({ clock, camera }) => {
    if (root.current) {
      const p = live.get(asset.id);
      if (p) {
        root.current.position.copy(p);
        if (orbiting) root.current.quaternion.copy(surfaceQuat(p));
      }
    }
    if (body.current) {
      const target = selected ? 1.45 : hover ? 1.2 : 1;
      body.current.scale.lerp(new THREE.Vector3(target, target, target), 0.12);
    }
    if (ring.current) {
      ring.current.lookAt(camera.position);
      const p = (clock.elapsedTime * 0.55) % 1;
      ring.current.scale.setScalar(1 + p * 2.6);
      (ring.current.material as THREE.MeshBasicMaterial).opacity =
        (1 - p) * (selected ? 0.55 : linking ? 0.42 : onRoute ? 0.28 : 0);
    }
  });

  /* label rendering is delegated to the decluttered screen-space layer */
  useLabel(
    showLabel || hover || selected
      ? {
          id: `asset-${asset.id}`,
          text: asset.name,
          sub: `${LAYER[asset.kind].label} · ${LAYER[asset.kind].altitude}`,
          detail: [
            asset.role,
            `${asset.health} · ${asset.altKm > 0 ? `${asset.altKm} km` : 'surface'}`,
            linking ? 'Comm window active' : '',
          ].filter(Boolean) as string[],
          color: LAYER[asset.kind].color,
          priority: selected
            ? 130
            : hover
              ? 120
              : onRoute
                ? 70
                : linking
                  ? 60
                  : asset.kind === 'ground'
                    ? 45
                    : asset.kind === 'satellite'
                      ? 30
                      : 25,
          minTier:
            asset.kind === 'satellite' || asset.kind === 'ground'
              ? 'global'
              : asset.kind === 'customer'
                ? 'local'
                : 'regional',
          emphasis: selected || hover || onRoute,
          getPosition: (out) => {
            const p = live.get(asset.id);
            if (!p) return null;
            return out.copy(p).setLength(p.length() + s * 3.4);
          },
        }
      : null
  );

  return (
    <group ref={root} position={position} quaternion={quat}>
      <group
        ref={body}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect({ type: 'asset', id: asset.id });
        }}
      >
        {/* invisible hit sphere so tiny models stay clickable */}
        <mesh visible={false}>
          <sphereGeometry args={[s * 2.2, 8, 8]} />
        </mesh>
        {asset.kind === 'satellite' ? (
          <Satellite s={s} color={color} />
        ) : asset.kind === 'haps' ? (
          <Haps s={s} color={color} />
        ) : asset.kind === 'drone' ? (
          <Drone s={s} color={color} />
        ) : asset.kind === 'ground' ? (
          <GroundStation s={s} color={color} />
        ) : (
          <CustomerNode s={s} color={color} />
        )}
      </group>

      <mesh ref={ring}>
        <ringGeometry args={[s * 1.9, s * 2.2, 32]} />
        <meshBasicMaterial
          color={linking ? '#e0f2fe' : KIND_COLOR[asset.kind]}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {tetherGeom && (
        // @ts-expect-error three line primitive
        <line geometry={tetherGeom}>
          <lineBasicMaterial
            color={KIND_COLOR[asset.kind]}
            transparent
            opacity={selected || onRoute ? 0.28 : 0.12}
            depthWrite={false}
          />
        </line>
      )}

    </group>
  );
}

/* -------------------------------------------------------------- weather */

function WeatherBlob({ cell }: { cell: WeatherCell }) {
  const position = useMemo(() => new THREE.Vector3(...geoToVec(cell.lat, cell.lon, 4)), [cell]);
  const ref = useRef<THREE.Group>(null);
  const color = cell.kind === 'STORM' ? '#f43f5e' : cell.kind === 'RAIN' ? '#38bdf8' : '#cbd5e1';

  useFrame(({ clock }) => {
    if (ref.current) {
      const p = 1 + Math.sin(clock.elapsedTime * 1.2 + cell.lat) * 0.06;
      ref.current.scale.setScalar(p);
      ref.current.rotation.y += 0.0008;
    }
  });

  return (
    <group ref={ref} position={position}>
      <mesh>
        <sphereGeometry args={[cell.size * 0.5, 24, 24]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.05 + cell.severity / 2200}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[cell.size * 0.3, 20, 20]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.07}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <AffectedFootprint cell={cell} color={color} />
    </group>
  );
}

/** Ground footprint of a weather cell — the area operators must route around. */
function AffectedFootprint({ cell, color }: { cell: WeatherCell; color: string }) {
  const position = useMemo(
    () => new THREE.Vector3(...geoToVec(cell.lat, cell.lon, 0)).multiplyScalar(1.002),
    [cell]
  );
  const quat = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), position.clone().normalize());
    return q;
  }, [position]);
  const ring = useRef<THREE.Mesh>(null);
  const r = cell.size * 0.62;

  useFrame(({ clock }) => {
    if (!ring.current) return;
    const p = (clock.elapsedTime * 0.4 + cell.lon * 0.01) % 1;
    ring.current.scale.setScalar(0.6 + p * 0.6);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.45;
  });

  return (
    <group position={position.clone().sub(new THREE.Vector3(...geoToVec(cell.lat, cell.lon, 4)))} quaternion={quat}>
      <mesh>
        <ringGeometry args={[r * 0.92, r, 64]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={ring}>
        <ringGeometry args={[r * 0.96, r, 64]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}


/* ------------------------------------------------ global-view abstractions */

/** Operational region badge shown when the Earth is viewed from far away. */
function RegionMarker({
  region,
  counts,
  onFocus,
}: {
  region: RegionDef;
  counts: { assets: number; ground: number };
  onFocus: (r: RegionDef) => void;
}) {
  const [hover, setHover] = useState(false);
  const position = useMemo(
    () => new THREE.Vector3(...geoOnShell(region.lat, region.lon, 1.004)),
    [region]
  );
  const quat = useMemo(() => {
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), position.clone().normalize());
    return q;
  }, [position]);
  const pulse = useRef<THREE.Mesh>(null);
  const r = region.spread;

  useFrame(({ clock }) => {
    if (!pulse.current) return;
    const t = (clock.elapsedTime * 0.45) % 1;
    pulse.current.scale.setScalar(0.7 + t * 0.9);
    (pulse.current.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.5;
  });

  return (
    <group position={position} quaternion={quat}>
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onFocus(region);
        }}
      >
        <circleGeometry args={[r * 1.15, 40]} />
        <meshBasicMaterial color={CYAN} transparent opacity={hover ? 0.12 : 0.05} depthWrite={false} />
      </mesh>
      <mesh>
        <ringGeometry args={[r * 0.94, r, 64]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={pulse}>
        <ringGeometry args={[r * 0.97, r, 64]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Html center distanceFactor={2.6} position={[0, r * 1.55, 0.02]} zIndexRange={[18, 0]}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onFocus(region);
          }}
          className="whitespace-nowrap rounded border border-sky-300/25 bg-[#050a13]/80 px-2 py-1 text-center font-mono uppercase backdrop-blur-sm transition-colors hover:border-sky-300/60"
        >
          <span className="block text-[10px] tracking-[0.22em] text-sky-100">{region.name}</span>
          <span className="block text-[8px] tracking-[0.18em] text-sky-300/60">
            {counts.assets} assets · {counts.ground} gateway
          </span>
        </button>
      </Html>
    </group>
  );
}

/** Simplified trunk corridor between two operational regions (global view). */
function TrunkRoute({ a, b }: { a: RegionDef; b: RegionDef }) {
  const curve = useMemo(() => {
    const p = new THREE.Vector3(...geoOnShell(a.lat, a.lon, 1.01));
    const q = new THREE.Vector3(...geoOnShell(b.lat, b.lon, 1.01));
    const mid = p.clone().add(q).multiplyScalar(0.5).setLength(1.42);
    return new THREE.QuadraticBezierCurve3(p, mid, q);
  }, [a, b]);
  const packs = useRef<THREE.Group>(null);
  const t = useRef(0);

  useFrame((_, d) => {
    t.current = (t.current + d * 0.13) % 1;
    packs.current?.children.forEach((child, i) => {
      const p = (t.current + i / 3) % 1;
      child.position.copy(curve.getPointAt(p));
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
      mat.opacity = Math.sin(p * Math.PI) * 0.9;
    });
  });

  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 64, 0.0035, 6, false]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.35} depthWrite={false} />
      </mesh>
      <group ref={packs}>
        {[0, 1, 2].map((i) => (
          <mesh key={i}>
            <sphereGeometry args={[0.008, 8, 8]} />
            <meshBasicMaterial color="#e0f2fe" transparent opacity={0.8} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <Html center distanceFactor={3} position={curve.getPointAt(0.5)} zIndexRange={[16, 0]}>
        <div className="pointer-events-none whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.22em] text-sky-200/60">
          Inter-region trunk
        </div>
      </Html>
    </group>
  );
}

/* ------------------------------------------------ vertical layer scaffold */

/**
 * The altitude ladder over an operational region: one disc per visual layer
 * plus a vertical spine, so the operator can read which shell an asset is on.
 */
function LayerScaffold({ region, detailed }: { region: RegionDef; detailed: boolean }) {
  const normal = useMemo(
    () => new THREE.Vector3(...geoOnShell(region.lat, region.lon, 1)).normalize(),
    [region]
  );
  const quat = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal),
    [normal]
  );

  const spine = useMemo(() => {
    const pts = [
      normal.clone().multiplyScalar(1.0),
      normal.clone().multiplyScalar(LAYER.satellite.radius + 0.03),
    ];
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [normal]);

  return (
    <group>
      {/* @ts-expect-error three line primitive */}
      <line geometry={spine}>
        <lineDashedMaterial color="#7dd3fc" transparent opacity={0.16} depthWrite={false} />
      </line>

      {LAYER_STACK.map((kind) => {
        const def = LAYER[kind];
        const r = def.radius;
        const disc = region.spread * (0.9 + (r - 1) * 1.5);
        const center = normal.clone().multiplyScalar(r);
        return (
          <group key={kind} position={center} quaternion={quat}>
            <mesh>
              <ringGeometry args={[disc * 0.985, disc, 72]} />
              <meshBasicMaterial
                color={def.color}
                transparent
                opacity={0.26}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            <mesh>
              <circleGeometry args={[disc, 48]} />
              <meshBasicMaterial
                color={def.color}
                transparent
                opacity={0.035}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            {detailed && (
              <Html
                center
                distanceFactor={1.5}
                position={[-disc * 1.22, 0, 0]}
                zIndexRange={[14, 0]}
              >
                <div className="pointer-events-none whitespace-nowrap text-right font-mono uppercase">
                  <div
                    className="text-[9px] tracking-[0.2em]"
                    style={{ color: def.color, opacity: 0.9 }}
                  >
                    {def.label}
                  </div>
                  <div className="text-[8px] tracking-[0.18em] text-foreground/40">
                    {def.altitude}
                  </div>
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

/* --------------------------------------------------------- camera focus */

function CameraRig({
  focusIds,
  live,
  approach,
  controls,
  view,
  onArrive,
}: {
  focusIds: string[] | null;
  live: LiveMap;
  approach: number;
  controls: React.RefObject<any>;
  /** one-shot smooth transition to a pre-designed readable framing */
  view: CameraView | null;
  onArrive: () => void;
}) {
  const desired = useRef(new THREE.Vector3());
  const target = useRef(new THREE.Vector3());
  useFrame(({ camera }, d) => {
    const c = controls.current;
    if (!c) return;
    const k = 1 - Math.exp(-2.6 * d);

    if (view) {
      c.target.lerp(view.target, k * 0.9);
      camera.position.lerp(view.position, k * 0.85);
      c.update();
      if (
        camera.position.distanceTo(view.position) < 0.03 &&
        c.target.distanceTo(view.target) < 0.03
      ) {
        onArrive();
      }
      return;
    }

    if (focusIds && focusIds.length) {
      target.current.set(0, 0, 0);
      let n = 0;
      for (const id of focusIds) {
        const p = live.get(id);
        if (p) {
          target.current.add(p);
          n += 1;
        }
      }
      if (n === 0) return;
      target.current.multiplyScalar(1 / n);
      const t = target.current;
      c.target.lerp(t, k);
      // rotate + zoom so the selection sits clearly off the limb, never edge-on
      const dist = Math.max(1.52, t.length() + approach);
      stationInto(desired.current, t, dist, 18, 10);
      camera.position.lerp(desired.current, k * 0.95);
    } else {
      c.target.lerp(new THREE.Vector3(0, 0, 0), k * 0.6);
    }
    c.update();
  });
  return null;
}

/* ------------------------------------------------------------ the scene */

function SceneContent({
  state,
  onLod,
  preset,
  presetSeq,
  onPresetDone,
}: {
  state: OloLinkState;
  onLod: (s: LodState) => void;
  preset: PresetId | null;
  presetSeq: number;
  onPresetDone: () => void;
}) {
  const { profile, links, selection, select, layers, route, previousRoute, rerouteSeq } = state;
  const controls = useRef<any>(null);

  const routeSegmentIds = useMemo(() => new Set(route.map((s) => s.id)), [route]);
  const routeAssets = useMemo(() => new Set(profile.route), [profile]);

  /** selecting a link on the active route lights the whole path */
  const highlightIds = useMemo(() => {
    if (selection?.type !== 'link') return new Set<string>();
    if (routeSegmentIds.has(selection.id)) return routeSegmentIds;
    return new Set([selection.id]);
  }, [selection, routeSegmentIds]);

  const live = useMemo(createLiveMap, []);

  /** satellites currently holding a communication window, by receiver */
  const windowSats = useMemo(
    () => new Set(Object.values(state.windows).filter(Boolean) as string[]),
    [state.windows]
  );
  const windowReceivers = useMemo(
    () => new Set(Object.entries(state.windows).filter(([, v]) => v).map(([k]) => k)),
    [state.windows]
  );

  const focus = useMemo(() => {
    if (!selection) return null;
    if (selection.type === 'asset') return [selection.id];
    const l = links.find((x) => x.segment.id === selection.id);
    if (!l) return null;
    return [l.segment.from, l.segment.to];
  }, [selection, links]);

  const approach = selection?.type === 'asset' ? 0.42 : 0.85;

  /* ------------------------------------------------------ level of detail */

  const [lod, setLod] = useState<LodState>({ level: 'global', region: null });
  const [view, setView] = useState<CameraView | null>(null);

  useEffect(() => {
    onLod(lod);
  }, [lod, onLod]);

  /* smart camera presets -> a pre-designed readable framing */
  useEffect(() => {
    if (!preset) return;
    if (preset === 'active-link') {
      const points: THREE.Vector3[] = [];
      for (const id of profile.route) {
        const p = live.get(id);
        if (p) points.push(p.clone());
      }
      const v = fitView(points, 20);
      if (v) setView(v);
    } else {
      const v = presetView(preset);
      if (v) setView(v);
    }
    select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, presetSeq]);

  /** the region the operator is working in: camera-derived, or the selection's */
  const activeRegion = useMemo(() => {
    if (selection?.type === 'asset') {
      const r = ASSET_BY_ID[selection.id];
      if (r) return regionIdOf(r) ?? lod.region;
    }
    return lod.region;
  }, [selection, lod.region]);

  const detailed = lod.level !== 'global';
  const localView = lod.level === 'local';

  const inScope = useMemo(
    () => (regionId: string | null) => !activeRegion || regionId === activeRegion,
    [activeRegion]
  );

  /** progressive reveal: only surface + orbital tiers exist at global range */
  const visibleAssets = useMemo(
    () =>
      ASSETS.filter((a) => {
        const region = regionIdOf(a);
        if (a.kind === 'satellite') return true;
        if (a.kind === 'ground') return true;
        if (!detailed) return false;
        return inScope(region);
      }),
    [detailed, inScope]
  );
  const visibleIds = useMemo(() => new Set(visibleAssets.map((a) => a.id)), [visibleAssets]);

  const visibleLinks = useMemo(
    () =>
      links.filter((l) => {
        const from = ASSET_BY_ID[l.segment.from];
        const to = ASSET_BY_ID[l.segment.to];
        if (!from || !to) return false;
        if (!visibleIds.has(from.id) || !visibleIds.has(to.id)) return false;
        // at global range only the primary space-to-ground path is drawn
        if (!detailed) return from.kind === 'satellite' && to.kind === 'ground';
        return true;
      }),
    [links, visibleIds, detailed]
  );

  const scopedRegions = useMemo(
    () => REGIONS.filter((r) => inScope(r.id)),
    [inScope]
  );

  const visibleWeather = useMemo(() => {
    if (!detailed) return [];
    return profile.weather.filter((c) => {
      if (!activeRegion) return true;
      const r = REGION_BY_ID[activeRegion];
      if (!r) return true;
      return Math.abs(c.lat - r.lat) < 25 && Math.abs(c.lon - r.lon) < 30;
    });
  }, [profile.weather, detailed, activeRegion]);

  const regionCounts = useMemo(
    () =>
      Object.fromEntries(
        REGIONS.map((r) => [
          r.id,
          {
            assets: ASSETS.filter((a) => a.region === r.name).length,
            ground: ASSETS.filter((a) => a.region === r.name && a.kind === 'ground').length,
          },
        ])
      ) as Record<string, { assets: number; ground: number }>,
    []
  );

  return (
    <>
      {/* sun: gives a visible day / night terminator across both regions */}
      <ambientLight intensity={0.22} />
      <directionalLight
        position={[SUN_DIR.x * 6, SUN_DIR.y * 6, SUN_DIR.z * 6]}
        intensity={3.1}
        color="#fff6e8"
      />
      {/* faint night-side fill so the dark hemisphere stays readable */}
      <directionalLight
        position={[-SUN_DIR.x * 6, -SUN_DIR.y * 6, -SUN_DIR.z * 6]}
        intensity={0.16}
        color="#2b4a72"
      />
      <Stars radius={90} depth={40} count={2200} factor={2.6} saturation={0} fade speed={0.3} />

      <LodDriver onChange={setLod} />

      <Suspense fallback={null}>
        <Earth />
      </Suspense>

      <OrbitDriver state={state} live={live} />

      {layers.orbits && SATELLITES.map((a) => <OrbitTrack key={a.id} elId={a.id} />)}

      {/* GLOBAL — operational regions and the trunk between them */}
      <Fade show={!detailed}>
        {REGIONS.map((r) => (
          <RegionMarker
            key={r.id}
            region={r}
            counts={regionCounts[r.id]!}
            onFocus={(reg) => {
              select(null);
              setView(presetView(reg.id as PresetId) ?? pointView(new THREE.Vector3(...geoOnShell(reg.lat, reg.lon, 1.06)), 1.95, 24));
            }}
          />
        ))}
        {REGIONS[0] && REGIONS[1] && <TrunkRoute a={REGIONS[0]} b={REGIONS[1]} />}
      </Fade>

      {/* REGIONAL / LOCAL — altitude ladder above the operational region */}
      <Fade show={detailed}>
        {scopedRegions.map((r) => (
          <LayerScaffold key={r.id} region={r} detailed={localView} />
        ))}
      </Fade>

      {layers.routes &&
        visibleLinks.map((l) =>
          ASSET_BY_ID[l.segment.from]?.kind === 'satellite' ? (
            <DownlinkBeam
              key={l.segment.id}
              link={l}
              live={live}
              inWindow={state.windows[l.segment.to] === l.segment.from}
              selected={selection?.type === 'link' && selection.id === l.segment.id}
              highlighted={highlightIds.has(l.segment.id)}
              onSelect={select}
            />
          ) : (
            <LinkPath
              key={l.segment.id}
              link={l}
              selected={selection?.type === 'link' && selection.id === l.segment.id}
              onRoute={routeSegmentIds.has(l.segment.id)}
              highlighted={highlightIds.has(l.segment.id)}
              onSelect={select}
            />
          )
        )}

      {/* AI rerouting: old path dissolves, new path draws itself in */}
      {layers.routes && detailed && previousRoute && previousRoute.length > 0 && (
        <>
          <ProgressiveRoute
            key={`out-${rerouteSeq}`}
            segments={previousRoute.filter((sg) => ASSET_BY_ID[sg.from]?.kind !== 'satellite')}
            seq={rerouteSeq}
            mode="out"
            color="#94a3b8"
          />
          <ProgressiveRoute
            key={`in-${rerouteSeq}`}
            segments={route.filter((sg) => ASSET_BY_ID[sg.from]?.kind !== 'satellite')}
            seq={rerouteSeq}
            mode="in"
            color="#e0f2fe"
          />
        </>
      )}

      {visibleAssets.map((a) => (
        <AssetNode
          key={a.id}
          asset={a}
          selected={selection?.type === 'asset' && selection.id === a.id}
          onRoute={routeAssets.has(a.id)}
          onSelect={select}
          showLabel={
            layers.labels &&
            (detailed
              ? routeAssets.has(a.id) || windowSats.has(a.id) || a.kind !== 'satellite'
              : routeAssets.has(a.id) && a.kind === 'satellite')
          }
          detail={localView}
          tether={detailed && a.altKm > 0 && a.kind !== 'satellite'}
          live={live}
          linking={windowSats.has(a.id) || windowReceivers.has(a.id)}
        />
      ))}

      {layers.weather && visibleWeather.map((c) => <WeatherBlob key={c.id} cell={c} />)}

      <OrbitControls
        ref={controls}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.45}
        minDistance={1.32}
        maxDistance={5.2}
        autoRotate={!selection && !view && lod.level === 'global' && state.running}
        autoRotateSpeed={0.22}
      />
      <CameraRig
        focusIds={view ? null : focus}
        live={live}
        approach={approach}
        controls={controls}
        view={view}
        onArrive={() => {
          setView(null);
          onPresetDone();
        }}
      />
      <LabelProjector tier={lod.level} />
    </>
  );
}

function ViewMenu({
  preset,
  onSelect,
  tier,
}: {
  preset: PresetId | null;
  onSelect: (id: PresetId) => void;
  tier: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id: PresetId) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-[8px] border border-white/[0.08] bg-[#070b14]/75 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-sky-100/80 backdrop-blur-md transition-colors hover:border-sky-300/40 hover:text-sky-100"
      >
        View
        <span className="text-[8px] text-sky-200/70" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[40px] w-[200px] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#070b14]/95 py-1 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl"
        >
          {CAMERA_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              title={p.hint}
              onClick={() => pick(p.id)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-[0.18em] transition-colors ${
                preset === p.id
                  ? 'bg-sky-400/[0.14] text-sky-100'
                  : 'text-sky-100/60 hover:bg-white/[0.05] hover:text-sky-100'
              }`}
            >
              {p.label} View
            </button>
          ))}
          <span className="my-1 block h-px bg-white/[0.07]" />
          <button
            type="button"
            role="menuitem"
            title="Return to the optimal readable operational angle"
            onClick={() => pick('global')}
            className="block w-full px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-[0.18em] text-sky-200/70 transition-colors hover:bg-white/[0.05] hover:text-sky-100"
          >
            Reset Operational View
          </button>
          <span className="my-1 block h-px bg-white/[0.07]" />
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[8px] uppercase tracking-[0.24em] text-muted-foreground/50">
              Tier
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-sky-100/70">{tier}</span>
          </div>
        </div>
      )}
    </div>
  );
}


export function GlobeScene({ state }: { state: OloLinkState }) {
  const [lod, setLod] = useState<LodState>({ level: 'global', region: null });
  const onLod = useMemo(() => (s: LodState) => setLod(s), []);
  const [preset, setPreset] = useState<PresetId | null>(null);
  const [presetSeq, setPresetSeq] = useState(0);
  const [menuSlot, setMenuSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setMenuSlot(document.getElementById('ololink-view-menu-slot'));
  }, []);

  const goTo = (id: PresetId) => {
    setPreset(id);
    setPresetSeq((n) => n + 1);
  };

  return (
    <LabelLayer tier={lod.level}>
      <Canvas
        /* framed over the Pacific so both Thailand and the United States are in view */
        camera={{ position: [OPERATIONAL_VIEW.position.x, OPERATIONAL_VIEW.position.y, OPERATIONAL_VIEW.position.z], fov: 42 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
        onPointerMissed={() => state.select(null)}
        className="!absolute inset-0"
      >
        <color attach="background" args={['#000000']} />
        <LodContext.Provider value={lod}>
          <SceneContent
            state={state}
            onLod={onLod}
            preset={preset}
            presetSeq={presetSeq}
            onPresetDone={() => setPreset(null)}
          />
        </LodContext.Provider>
      </Canvas>

      {/* single compact camera control — rendered into the top navigation bar */}
      {menuSlot &&
        createPortal(
          <ViewMenu
            preset={preset}
            onSelect={goTo}
            tier={`${LOD_LABEL[lod.level]}${lod.region ? ` · ${REGION_BY_ID[lod.region]?.short}` : ''}`}
          />,
          menuSlot
        )}


    </LabelLayer>
  );
}


export { routeSegments };
export type { ScenarioProfile };
