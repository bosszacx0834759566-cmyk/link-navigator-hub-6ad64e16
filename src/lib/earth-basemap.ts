/**
 * Builds the 2D basemap as a flattened version of the exact Earth used by the
 * 3D globe: same satellite albedo texture, same cloud layer, same sun
 * direction / night-lights treatment. Rendered once into a canvas and reused
 * as a single raster so the 2D map and the globe read as one planet.
 */

import earthDay from '@/assets/earth_atmos_2048.jpg';
import earthNight from '@/assets/earth_lights_2048.png';
import earthClouds from '@/assets/earth_clouds_1024.png';

/** Subsolar point — must match SUN_DIR in globe-scene (geoToVec(14, 178)). */
const SUN_LAT = 14;
const SUN_LON = 178;

const W = 2048;
const H = 1024;

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function draw(img: HTMLImageElement) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}

/**
 * Soft-blurred cloud coverage: downscale the cloud texture hard, then upscale
 * with smoothing so the baked clouds read as a smooth atmospheric layer
 * instead of a pixelated grey texture.
 */
function drawCloudsBlurred(img: HTMLImageElement) {
  // pass 1: draw the cloud mask at half res behind a real gaussian blur
  const MW = W / 2;
  const MH = H / 2;
  const mid = document.createElement('canvas');
  mid.width = MW;
  mid.height = MH;
  const mctx = mid.getContext('2d')!;
  if ('filter' in mctx) mctx.filter = 'blur(10px)';
  mctx.drawImage(img, 0, 0, MW, MH);
  mctx.filter = 'none';

  // pass 2: blur again while upscaling — soft, smooth atmospheric coverage
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = 'blur(8px)';
  ctx.drawImage(mid, 0, 0, W, H);
  ctx.filter = 'none';
  return ctx.getImageData(0, 0, W, H).data;
}

let cache: Promise<string> | null = null;

export function earthBasemap(): Promise<string> {
  if (cache) return cache;
  cache = (async () => {
    const [day, night, clouds] = await Promise.all([
      loadImage(earthDay),
      loadImage(earthNight),
      loadImage(earthClouds),
    ]);
    const d = draw(day);
    const n = draw(night);
    const cl = drawCloudsBlurred(clouds);

    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d')!;
    const image = ctx.createImageData(W, H);
    const px = image.data;

    const slat = (SUN_LAT * Math.PI) / 180;
    const slon = (SUN_LON * Math.PI) / 180;

    for (let y = 0; y < H; y++) {
      const lat = ((90 - (y + 0.5) * (180 / H)) * Math.PI) / 180;
      const sinPart = Math.sin(lat) * Math.sin(slat);
      const cosPart = Math.cos(lat) * Math.cos(slat);
      for (let x = 0; x < W; x++) {
        const lon = (((x + 0.5) * (360 / W) - 180) * Math.PI) / 180;
        const cosSun = sinPart + cosPart * Math.cos(lon - slon);

        const i = (y * W + x) * 4;
        // cloud coverage (greyscale texture used as both colour and alpha)
        const cAlpha = (cl[i]! / 255) * 0.26;

        let r = d[i]!;
        let g = d[i + 1]!;
        let b = d[i + 2]!;
        // clouds over albedo
        r = r * (1 - cAlpha) + 223 * cAlpha;
        g = g * (1 - cAlpha) + 231 * cAlpha;
        b = b * (1 - cAlpha) + 238 * cAlpha;

        // sun lighting: soft terminator, dark but not black night side
        const lightFactor = 0.46 + 0.62 * smoothstep(-0.18, 0.32, cosSun);
        r *= lightFactor;
        g *= lightFactor;
        b *= lightFactor;

        // city lights, additive, masked to the night hemisphere
        const nightMask = smoothstep(0.12, -0.22, cosSun) * (1 - cAlpha * 0.8);
        if (nightMask > 0.01) {
          const l = nightMask * 0.9;
          r += n[i]! * l;
          g += n[i + 1]! * 0.82 * l;
          b += n[i + 2]! * 0.55 * l;
        }

        px[i] = Math.min(255, r);
        px[i + 1] = Math.min(255, g);
        px[i + 2] = Math.min(255, b);
        px[i + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return out.toDataURL('image/jpeg', 0.92);
  })();
  return cache;
}
