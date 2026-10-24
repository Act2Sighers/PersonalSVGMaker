import type { Doc, Fill, Layer, Paint, Vec } from './types';
import { uid } from './doc';
import { computeFaces, faceAt, pointInFace, type Face } from './regions';

/** 境界の線がこの割合以上一致していれば「同じ範囲が形を変えたもの」とみなす */
const SAME_SHAPE = 0.75;
/** 元の範囲の内側に収まる新しい範囲は、分割されたものとみなす（面積がこの倍率まで） */
const SPLIT_AREA = 1.05;
/** 分割とみなすのに必要な、元の範囲との線の共通度 */
const SHARED_SOME = 0.3;

function jaccard(a: Set<string>, b: Iterable<string>): number {
  const bs = new Set(b);
  let inter = 0;
  for (const x of a) if (bs.has(x)) inter++;
  const union = a.size + bs.size - inter;
  return union ? inter / union : 0;
}

function movePaint(p: Paint, d: Vec): Paint {
  if (p.type !== 'linear' || (!d.x && !d.y)) return p;
  return { ...p, x1: p.x1 + d.x, y1: p.y1 + d.y, x2: p.x2 + d.x, y2: p.y2 + d.y };
}

export function layerFaces(l: Layer): Face[] {
  return computeFaces(l.shapes);
}

/** 塗りが今どの範囲を塗っているか（保留中なら null） */
export function fillFace(l: Layer, f: Fill): Face | null {
  return f.pending ? null : faceAt(layerFaces(l), f.seed);
}

/**
 * 線が変わったあとに、塗りを新しい範囲へ引き継ぐ。
 *  - 境界の線がほぼ同じ範囲 → 移動・変形したものとして引き継ぐ
 *  - 元の範囲の内側に収まる範囲 → 分割されたものとして、それぞれに引き継ぐ
 *  - 引き継ぎ先がない（範囲が開いた）→ 保留にし、同じ線で閉じ直されたら塗り直す
 */
export function reconcileFills(before: Doc, after: Doc) {
  for (const layer of after.layers) {
    const old = before.layers.find((l) => l.id === layer.id);
    if (!old || !layer.fills.length) continue;
    if (JSON.stringify(old.shapes) === JSON.stringify(layer.shapes)) continue;

    const oldFaces = layerFaces(old);
    const newFaces = layerFaces(layer);

    type Parent = { face: Face | null; sig: Set<string>; fill: Fill | null };
    const parents: Parent[] = oldFaces.map((face) => ({ face, sig: face.sig, fill: null }));
    for (const f of layer.fills) {
      const face = f.pending ? null : faceAt(oldFaces, f.seed);
      const p = face && parents.find((x) => x.face === face);
      if (p) p.fill = f;
      else parents.push({ face: null, sig: new Set(f.sig), fill: f });
    }

    const children = new Map<Parent, Face[]>();
    for (const nf of newFaces) {
      // 線の一致で探す（移動・変形）
      let bySig: Parent | null = null, bestScore = SAME_SHAPE;
      for (const p of parents) {
        const s = jaccard(p.sig, nf.sig);
        if (s >= bestScore) { bestScore = s; bySig = p; }
      }
      // 位置で探す（分割・変化なし）：元の範囲の中に収まっている
      let byPos: Parent | null = null;
      for (const p of parents)
        if (p.face && pointInFace(nf.interior, p.face) && nf.area <= p.face.area * SPLIT_AREA && (!byPos || p.face.area < byPos.face!.area)) byPos = p;
      // 両方見つかって食い違うときは、位置で見つけた範囲と線が少しでも共通していればそちらを優先
      // （別の図形の上へ移動してきた場合は、線が共通しないので線の一致を優先する）
      let best = byPos ?? bySig;
      if (byPos && bySig && byPos !== bySig && jaccard(byPos.sig, nf.sig) < SHARED_SOME) best = bySig;
      if (best) children.set(best, [...(children.get(best) ?? []), nf]);
    }

    const fills: Fill[] = [];
    for (const p of parents) {
      if (!p.fill) continue;
      const kids = children.get(p) ?? [];
      if (!kids.length) {
        fills.push({ ...p.fill, pending: true, sig: [...p.sig] });
        continue;
      }
      kids.forEach((k, i) => {
        const moved = p.face && jaccard(p.face.sig, k.sig) >= SAME_SHAPE;
        const d = moved ? { x: k.centroid.x - p.face!.centroid.x, y: k.centroid.y - p.face!.centroid.y } : { x: 0, y: 0 };
        fills.push({ id: i === 0 ? p.fill!.id : uid(), seed: k.interior, paint: movePaint(p.fill!.paint, d), sig: [...k.sig], pending: false });
      });
    }
    layer.fills = fills;
  }
}

/** 点 p を含む範囲を塗る（既に塗りがあれば置き換える）。範囲がなければ false。 */
export function applyFill(layer: Layer, p: Vec, paint: Paint | null): boolean {
  const faces = layerFaces(layer);
  const face = faceAt(faces, p);
  if (!face) return false;
  layer.fills = layer.fills.filter((f) => f.pending || faceAt(faces, f.seed) !== face);
  if (paint) layer.fills.push({ id: uid(), seed: face.interior, paint, sig: [...face.sig], pending: false });
  return true;
}

export function pendingCount(doc: Doc): number {
  return doc.layers.reduce((n, l) => n + l.fills.filter((f) => f.pending).length, 0);
}
