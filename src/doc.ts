import type { Doc, Layer, PathNode, PathShape, PointRef, Shape, Vec } from './types';
import { add, sub, type Prim } from './geom';

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function newLayer(name: string): Layer {
  return { id: uid(), name, visible: true, locked: false, shapes: [] };
}

export function newDoc(name = '無題', width = 512, height = 512): Doc {
  const now = Date.now();
  return {
    version: 1,
    id: uid(),
    name,
    width,
    height,
    grid: { originX: 0, originY: 0, spacing: 16, majorEvery: 4, visible: true },
    layers: [newLayer('レイヤー 1')],
    createdAt: now,
    updatedAt: now,
  };
}

export const cloneDoc = (d: Doc): Doc => structuredClone(d);

export function allShapes(doc: Doc, visibleOnly = true): Shape[] {
  const out: Shape[] = [];
  for (const l of doc.layers) if (!visibleOnly || l.visible) out.push(...l.shapes);
  return out;
}

export function findShape(doc: Doc, id: string): Shape | undefined {
  for (const l of doc.layers) for (const s of l.shapes) if (s.id === id) return s;
  return undefined;
}

export const ref = (shapeId: string, key: string): PointRef => `${shapeId}:${key}`;
export function parseRef(r: PointRef): [string, string] {
  const i = r.lastIndexOf(':');
  return [r.slice(0, i), r.slice(i + 1)];
}

/** 図形の「掴める点」（ハンドルを除く）のキー */
export function anchorKeys(s: Shape): string[] {
  if (s.type === 'circle') return ['c'];
  return s.nodes.map((_, i) => `n${i}`);
}

export function getPoint(s: Shape, key: string): Vec | null {
  if (s.type === 'circle') {
    return key === 'c' ? { x: s.cx, y: s.cy } : null;
  }
  const i = Number(key.slice(1));
  const n = s.nodes[i];
  if (!n) return null;
  if (key[0] === 'n') return { x: n.x, y: n.y };
  if (key[0] === 'i') return n.hin;
  if (key[0] === 'o') return n.hout;
  return null;
}

export function pathPrims(s: PathShape): Prim[] {
  const out: Prim[] = [];
  const n = s.nodes.length;
  const segs = s.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const A = s.nodes[i], B = s.nodes[j];
    const keys = [ref(s.id, `n${i}`), ref(s.id, `o${i}`), ref(s.id, `i${j}`), ref(s.id, `n${j}`)];
    if (!A.hout && !B.hin) out.push({ kind: 'line', a: { x: A.x, y: A.y }, b: { x: B.x, y: B.y }, keys });
    else
      out.push({
        kind: 'cubic',
        p0: { x: A.x, y: A.y },
        p1: A.hout ?? { x: A.x, y: A.y },
        p2: B.hin ?? { x: B.x, y: B.y },
        p3: { x: B.x, y: B.y },
        keys,
      });
  }
  return out;
}

export function shapePrims(s: Shape): Prim[] {
  if (s.type === 'circle') {
    return [{ kind: 'circle', c: { x: s.cx, y: s.cy }, r: s.r, keys: [ref(s.id, 'c')] }];
  }
  return pathPrims(s);
}

/** 選択された点を delta だけ動かす（doc を直接書き換える） */
export function translatePoints(doc: Doc, sel: Set<PointRef>, delta: Vec) {
  const byShape = new Map<string, Set<string>>();
  for (const r of sel) {
    const [id, key] = parseRef(r);
    if (!byShape.has(id)) byShape.set(id, new Set());
    byShape.get(id)!.add(key);
  }
  for (const [id, keys] of byShape) {
    const s = findShape(doc, id);
    if (!s) continue;
    if (s.type === 'circle') {
      if (keys.has('c')) {
        s.cx += delta.x;
        s.cy += delta.y;
      }
      continue;
    }
    s.nodes.forEach((n, i) => {
      if (keys.has(`n${i}`)) {
        n.x += delta.x;
        n.y += delta.y;
        if (n.hin) n.hin = add(n.hin, delta);
        if (n.hout) n.hout = add(n.hout, delta);
      } else {
        if (keys.has(`i${i}`) && n.hin) n.hin = add(n.hin, delta);
        if (keys.has(`o${i}`) && n.hout) n.hout = add(n.hout, delta);
      }
    });
  }
}

/** 選択点を削除。パスは頂点を取り除き、2点未満になれば図形ごと消す。円は中心が選ばれていれば消す。 */
export function deletePoints(doc: Doc, sel: Set<PointRef>) {
  for (const l of doc.layers) {
    l.shapes = l.shapes.filter((s) => {
      if (s.type === 'circle') return !anchorKeys(s).some((k) => sel.has(ref(s.id, k)));
      const keep = s.nodes.filter((_, i) => !sel.has(ref(s.id, `n${i}`)));
      if (keep.length === s.nodes.length) {
        // ハンドルだけが選ばれていた場合はハンドルを消す
        s.nodes.forEach((n, i) => {
          if (sel.has(ref(s.id, `i${i}`))) n.hin = null;
          if (sel.has(ref(s.id, `o${i}`))) n.hout = null;
        });
        return true;
      }
      s.nodes = keep;
      if (s.nodes.length < 3) s.closed = false;
      return s.nodes.length >= 2;
    });
  }
}

/** 選択された頂点のハンドルを消して角にする */
export function makeCorner(doc: Doc, sel: Set<PointRef>) {
  for (const s of allShapes(doc, false)) {
    if (s.type !== 'path') continue;
    s.nodes.forEach((n, i) => {
      if (sel.has(ref(s.id, `n${i}`))) {
        n.hin = null;
        n.hout = null;
      }
    });
  }
}

/** 存在しない参照を除く */
export function pruneSelection(doc: Doc, sel: Set<PointRef>): Set<PointRef> {
  const out = new Set<PointRef>();
  for (const r of sel) {
    const [id, key] = parseRef(r);
    const s = findShape(doc, id);
    if (s && getPoint(s, key)) out.add(r);
  }
  return out;
}

export function regularPolygon(center: Vec, vertex: Vec, sides: number): Vec[] {
  const d = sub(vertex, center);
  const r = Math.hypot(d.x, d.y);
  const a0 = Math.atan2(d.y, d.x);
  const pts: Vec[] = [];
  for (let i = 0; i < sides; i++) {
    const a = a0 + (i * 2 * Math.PI) / sides;
    pts.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
  }
  return pts;
}

/** 書き出し用 SVG パスデータ */
export function shapeToPathData(s: Shape): string {
  const f = (n: number) => +n.toFixed(3);
  if (s.type === 'circle') {
    const { cx, cy, r } = s;
    return `M${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 1 ${f(cx + r)} ${f(cy)}Z`;
  }
  let d = `M${f(s.nodes[0].x)} ${f(s.nodes[0].y)}`;
  for (const p of pathPrims(s)) {
    if (p.kind === 'line') d += `L${f(p.b.x)} ${f(p.b.y)}`;
    else if (p.kind === 'cubic') d += `C${f(p.p1.x)} ${f(p.p1.y)} ${f(p.p2.x)} ${f(p.p2.y)} ${f(p.p3.x)} ${f(p.p3.y)}`;
  }
  return s.closed ? d + 'Z' : d;
}

export function docToLineSvg(doc: Doc): string {
  const paths = doc.layers
    .filter((l) => l.visible)
    .map(
      (l) =>
        `  <g id="${l.id}" data-name="${escapeXml(l.name)}">\n` +
        l.shapes.map((s) => `    <path d="${shapeToPathData(s)}"/>`).join('\n') +
        `\n  </g>`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}" width="${doc.width}" height="${doc.height}" fill="none" stroke="#000" stroke-width="1">\n${paths}\n</svg>\n`;
}

const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/**
 * 始点 a・通過点 b・終点 c を通る滑らかな曲線（放物線）を、b を頂点とする2区間のパスで返す。
 * b を頂点にしておくことで、後から通過点も動かせる。
 */
export function curveThrough3(a: Vec, b: Vec, c: Vec): PathNode[] | null {
  const d1 = Math.hypot(b.x - a.x, b.y - a.y), d2 = Math.hypot(c.x - b.x, c.y - b.y);
  if (d1 < 1e-9 || d2 < 1e-9) return null;
  const t = d1 / (d1 + d2);
  const u = 1 - t;
  // 2次ベジェの制御点 q（t で b を通る）
  const q = { x: (b.x - u * u * a.x - t * t * c.x) / (2 * t * u), y: (b.y - u * u * a.y - t * t * c.y) / (2 * t * u) };
  const c1 = { x: a.x + ((q.x - a.x) * 2) / 3, y: a.y + ((q.y - a.y) * 2) / 3 };
  const c2 = { x: c.x + ((q.x - c.x) * 2) / 3, y: c.y + ((q.y - c.y) * 2) / 3 };
  const L = (p: Vec, r: Vec) => ({ x: p.x + (r.x - p.x) * t, y: p.y + (r.y - p.y) * t });
  const p01 = L(a, c1), p12 = L(c1, c2), p23 = L(c2, c);
  const h1 = L(p01, p12), h2 = L(p12, p23);
  return [
    { x: a.x, y: a.y, hin: null, hout: p01 },
    { x: b.x, y: b.y, hin: h1, hout: h2 },
    { x: c.x, y: c.y, hin: p23, hout: null },
  ];
}
