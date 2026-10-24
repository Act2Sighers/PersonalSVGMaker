import type { Doc, Fill, Layer, Paint, Vec } from './types';
import { uid } from './doc';
import { computeFaces, faceAt, pointInFace, type Face } from './regions';

/** 境界の線がこの割合以上一致していれば「同じ範囲が形を変えたもの」とみなす */
const SAME_SHAPE = 0.75;
/** 位置で見つけた元の範囲を優先するのに必要な、線の共通度 */
const SHARED_SOME = 0.3;

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function movePaint(p: Paint, d: Vec): Paint {
  if (p.type !== 'linear' || (!d.x && !d.y)) return p;
  return { ...p, x1: p.x1 + d.x, y1: p.y1 + d.y, x2: p.x2 + d.x, y2: p.y2 + d.y };
}

export function layerFaces(l: Layer): Face[] {
  return computeFaces(l.shapes);
}

/** 塗りが今どの範囲を塗っているか */
export function fillFace(l: Layer, f: Fill): Face | null {
  return faceAt(layerFaces(l), f.seed);
}

/** 範囲の内側に散らばった確認用の点 */
function samplePoints(f: Face): Vec[] {
  const poly = f.outer.poly;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const out: Vec[] = [f.interior];
  const N = 8;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const p = { x: x0 + ((i + 0.5) / N) * (x1 - x0), y: y0 + ((j + 0.5) / N) * (y1 - y0) };
      if (pointInFace(p, f)) out.push(p);
    }
  return out;
}

/**
 * 線が変わったあとに、塗りを新しい範囲へ付け直す。
 *  - 境界の線がほぼ同じ範囲 → 移動・変形したものとして、同じ塗りを引き継ぐ
 *  - それ以外 → 範囲の内側が、変更前にどの塗りの上にあったかを調べ、いちばん多い塗りにする
 *    （塗られていなかった部分が多ければ塗らない）
 *  - 線が閉じなくなった範囲は存在しないので、その塗りは消える
 */
export function reconcileFills(before: Doc, after: Doc) {
  for (const layer of after.layers) {
    const old = before.layers.find((l) => l.id === layer.id);
    if (!old || !old.fills.length) continue;
    if (JSON.stringify(old.shapes) === JSON.stringify(layer.shapes)) continue;

    const oldFaces = layerFaces(old);
    const fillOf = new Map<Face, Fill>();
    for (const f of old.fills) {
      const face = faceAt(oldFaces, f.seed);
      if (face) fillOf.set(face, f);
    }

    const used = new Set<string>();
    const fills: Fill[] = [];
    const add = (src: Fill, face: Face, paint: Paint) => {
      const id = used.has(src.id) ? uid() : src.id;
      used.add(id);
      fills.push({ id, seed: face.interior, paint });
    };

    for (const nf of layerFaces(layer)) {
      let bySig: Face | null = null, bestScore = SAME_SHAPE;
      for (const of of oldFaces) {
        const s = jaccard(of.sig, nf.sig);
        if (s >= bestScore) { bestScore = s; bySig = of; }
      }
      const here = faceAt(oldFaces, nf.interior);
      // 移動・変形：位置で見つかる元の範囲が無関係なら、線の一致を信じる
      if (bySig && bySig !== here && (!here || jaccard(here.sig, nf.sig) < SHARED_SOME)) {
        const f = fillOf.get(bySig);
        if (f) add(f, nf, movePaint(f.paint, { x: nf.centroid.x - bySig.centroid.x, y: nf.centroid.y - bySig.centroid.y }));
        continue;
      }
      // 位置で決める：内側の点がどの塗りの上にあったかの多数決
      const votes = new Map<Fill | null, number>();
      for (const p of samplePoints(nf)) {
        const of = faceAt(oldFaces, p);
        const f = (of && fillOf.get(of)) ?? null;
        votes.set(f, (votes.get(f) ?? 0) + 1);
      }
      let winner: Fill | null = null, top = 0;
      for (const [f, n] of votes) if (n > top || (n === top && f)) { top = n; winner = f; }
      if (winner) add(winner, nf, winner.paint);
    }
    layer.fills = fills;
  }
}

/** 点 p を含む範囲を塗る（既に塗りがあれば置き換える）。範囲がなければ false。 */
export function applyFill(layer: Layer, p: Vec, paint: Paint | null): boolean {
  const faces = layerFaces(layer);
  const face = faceAt(faces, p);
  if (!face) return false;
  layer.fills = layer.fills.filter((f) => faceAt(faces, f.seed) !== face);
  if (paint) layer.fills.push({ id: uid(), seed: face.interior, paint });
  return true;
}
