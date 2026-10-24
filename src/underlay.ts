import type { Clip, Doc, UnderlayFrame, UnderlayPlacement } from './types';
import { uid } from './doc';
import { loadImage, saveImage } from './storage';

/**
 * 下書き画像（PNG・JPEG など）。画像は作品とは別に保存し、作品には ID と置き場所だけを持つ。
 * 大きすぎる画像は、保存する前に長辺 2048px まで縮める。
 */

const MAX_SIDE = 2048;
const cache = new Map<string, HTMLImageElement | 'loading' | 'missing'>();

/** 画像を返す。まだ読み込んでいなければ読み込みを始め、読み込めたら onLoad を呼ぶ */
export function getImage(id: string, onLoad: () => void): HTMLImageElement | null {
  const c = cache.get(id);
  if (c instanceof HTMLImageElement) return c.complete ? c : null;
  if (c) return null;
  cache.set(id, 'loading');
  loadImage(id).then((data) => {
    if (!data) { cache.set(id, 'missing'); return; }
    const img = new Image();
    img.onload = () => { cache.set(id, img); onLoad(); };
    img.onerror = () => cache.set(id, 'missing');
    img.src = data;
  });
  return null;
}

function readAsImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像として読み込めませんでした')); };
    img.src = url;
  });
}

/** 画像ファイルを読み込んで保存し、ID と大きさを返す */
export async function importImageFile(file: File): Promise<{ id: string; width: number; height: number }> {
  const src = await readAsImage(file);
  const k = Math.min(1, MAX_SIDE / Math.max(src.naturalWidth, src.naturalHeight));
  const w = Math.max(1, Math.round(src.naturalWidth * k)), h = Math.max(1, Math.round(src.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  // 透明な所がある画像は PNG、なければ容量の小さい JPEG で保存する
  const alpha = /png|gif|webp/i.test(file.type) && hasTransparency(ctx, w, h);
  const data = alpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
  const id = uid();
  await saveImage(id, data);
  const img = new Image();
  img.src = data;
  cache.set(id, img);
  return { id, width: w, height: h };
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true;
  return false;
}

/** キャンバスに収まるように置く */
export function fitPlacement(doc: Doc, image: string, iw: number, ih: number): UnderlayPlacement {
  const k = Math.min(doc.width / iw, doc.height / ih);
  const w = iw * k, h = ih * k;
  return { id: uid(), image, x: (doc.width - w) / 2, y: (doc.height - h) / 2, w, h, opacity: 0.5 };
}

/** その時刻に表示するアニメーションの下書き */
export function currentFrame(clip: Clip | null, t: number): UnderlayFrame | null {
  if (!clip?.underlays.length) return null;
  let cur: UnderlayFrame | null = null;
  for (const f of clip.underlays) if (f.t <= t + 1e-6 && (!cur || f.t >= cur.t)) cur = f;
  return cur;
}

/** 作品で使っている画像の ID */
export function imageIds(doc: Doc): string[] {
  return [...new Set([...doc.underlays.map((u) => u.image), ...doc.animations.flatMap((c) => c.underlays.map((u) => u.image))])];
}

/** 作品ファイルに画像を含めるため、画像のデータを集める */
export async function collectImages(doc: Doc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of imageIds(doc)) {
    const d = await loadImage(id);
    if (d) out[id] = d;
  }
  return out;
}

/** 作品ファイルに含まれていた画像を保存する */
export async function storeImages(images: Record<string, string> | undefined) {
  for (const [id, data] of Object.entries(images ?? {})) {
    if (typeof data === 'string' && data.startsWith('data:image/')) {
      await saveImage(id, data);
      cache.delete(id);
    }
  }
}
