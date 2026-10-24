import type { Doc, Fill, Layer, LayerNode } from './types';
import { allLayers, findNode, newFolder, newLayer } from './doc';
import { layerFaces } from './fills';
import { faceAt } from './regions';

/** 選んでいる項目のすぐ上に新しい項目を入れる（フォルダーを選んでいればその中の一番上） */
export function insertNode(doc: Doc, node: LayerNode) {
  const at = findNode(doc, doc.activeId);
  if (!at) doc.layers.push(node);
  else if (at.node.kind === 'folder') { at.node.children.push(node); at.node.open = true; }
  else at.siblings.splice(at.index + 1, 0, node);
  doc.activeId = node.id;
}

export function addLayer(doc: Doc) {
  insertNode(doc, newLayer(`レイヤー ${allLayers(doc).length + 1}`));
}

export function addFolder(doc: Doc) {
  const count = (nodes: LayerNode[]): number => nodes.reduce((n, x) => n + (x.kind === 'folder' ? 1 + count(x.children) : 0), 0);
  insertNode(doc, newFolder(`フォルダー ${count(doc.layers) + 1}`));
}

/** 削除できない（最後のレイヤーを含む）ときは false */
export function removeNode(doc: Doc, id: string): boolean {
  const at = findNode(doc, id);
  if (!at) return false;
  const inside = at.node.kind === 'folder' ? allLayers({ ...doc, layers: [at.node] }).length : 1;
  if (allLayers(doc).length - inside < 1) return false;
  at.siblings.splice(at.index, 1);
  const next = at.siblings[Math.min(at.index, at.siblings.length - 1)] ?? at.parent;
  doc.activeId = next?.id ?? allLayers(doc).at(-1)!.id;
  return true;
}

/** 一覧の上（描画順では後ろ）へ dir = +1、下へ dir = -1 */
export function shiftNode(doc: Doc, id: string, dir: 1 | -1): boolean {
  const at = findNode(doc, id);
  if (!at) return false;
  const j = at.index + dir;
  if (j < 0 || j >= at.siblings.length) return false;
  [at.siblings[at.index], at.siblings[j]] = [at.siblings[j], at.siblings[at.index]];
  return true;
}

/** フォルダーから出して、フォルダーのすぐ上に置く */
export function moveOutOfFolder(doc: Doc, id: string): boolean {
  const at = findNode(doc, id);
  if (!at?.parent) return false;
  const p = findNode(doc, at.parent.id)!;
  at.siblings.splice(at.index, 1);
  p.siblings.splice(p.index + 1, 0, at.node);
  return true;
}

/** すぐ上にあるフォルダーの中（一番下）に入れる */
export function moveIntoFolderAbove(doc: Doc, id: string): boolean {
  const at = findNode(doc, id);
  if (!at) return false;
  const above = at.siblings[at.index + 1];
  if (!above || above.kind !== 'folder') return false;
  at.siblings.splice(at.index, 1);
  above.children.unshift(at.node);
  above.open = true;
  return true;
}

/**
 * 図形を別のレイヤーへ移す。その図形だけで囲まれた範囲の塗りも一緒に移す。
 * 返り値の関数は、塗りの付け直しが終わったあとに呼ぶ（移した塗りを付ける）。
 */
export function moveShapesToLayer(doc: Doc, ids: Set<string>, target: Layer): () => void {
  const moved: Fill[] = [];
  for (const l of allLayers(doc)) {
    if (l === target) continue;
    const faces = layerFaces(l);
    for (const f of l.fills) {
      const face = faceAt(faces, f.seed);
      if (face && [...face.sig].every((src) => ids.has(src.slice(0, src.lastIndexOf(':'))))) moved.push(f);
    }
    const picked = l.shapes.filter((s) => ids.has(s.id));
    if (!picked.length) continue;
    l.shapes = l.shapes.filter((s) => !ids.has(s.id));
    target.shapes.push(...picked);
  }
  return () => {
    const faces = layerFaces(target);
    for (const f of moved) {
      const face = faceAt(faces, f.seed);
      if (!face) continue;
      target.fills = target.fills.filter((x) => faceAt(faces, x.seed) !== face);
      target.fills.push(f);
    }
  };
}
