import type { AnimProp, Clip, Doc, Ease, Keyframe, LayerNode, Track, Vec } from './types';
import { findNode, uid } from './doc';
import { shapePrims } from './doc';
import { cubicAt, type Affine } from './geom';

/**
 * アニメーション：レイヤーとフォルダーをパーツとして動かす。
 * フォルダーの動きは中のパーツにも及ぶ（親子関係がボーンの役割をする）。
 * 各パーツの変換は「中心点を基準に 拡大縮小 → 回転 → 移動」。
 */

export const PROPS: { id: AnimProp; label: string; unit: string; def: number }[] = [
  { id: 'rotate', label: '回転', unit: '°', def: 0 },
  { id: 'x', label: '左右', unit: '', def: 0 },
  { id: 'y', label: '上下', unit: '', def: 0 },
  { id: 'scaleX', label: '横の大きさ', unit: '倍', def: 1 },
  { id: 'scaleY', label: '縦の大きさ', unit: '倍', def: 1 },
  { id: 'opacity', label: '不透明度', unit: '', def: 1 },
];
export const propDef = (p: AnimProp) => PROPS.find((x) => x.id === p)!.def;

export const EASES: { id: Ease; label: string }[] = [
  { id: 'smooth', label: '滑らか' },
  { id: 'linear', label: '等速' },
  { id: 'step', label: '瞬時' },
];

export type Pose = Record<AnimProp, number>;
export const restPose = (): Pose => ({ rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 });

export function newClip(name: string): Clip {
  return { id: uid(), name, duration: 2, loop: true, tracks: [] };
}

/** つなぎ方に応じた進み具合（0〜1） */
export function easeValue(e: Ease, u: number): number {
  if (e === 'step') return 0;
  if (e === 'linear') return u;
  return u * u * (3 - 2 * u);
}

export function sampleTrack(keys: Keyframe[], t: number, def: number): number {
  if (!keys.length) return def;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b.t) {
      const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
      return a.v + (b.v - a.v) * easeValue(a.ease, u);
    }
  }
  return keys[keys.length - 1].v;
}

/** クリップの時刻 t での、各パーツの値 */
export function evalClip(clip: Clip | null, t: number): Map<string, Pose> {
  const out = new Map<string, Pose>();
  if (!clip) return out;
  for (const tr of clip.tracks) {
    const p = out.get(tr.node) ?? restPose();
    p[tr.prop] = sampleTrack(tr.keys, t, propDef(tr.prop));
    out.set(tr.node, p);
  }
  return out;
}

export function findTrack(clip: Clip, node: string, prop: AnimProp): Track | undefined {
  return clip.tracks.find((t) => t.node === node && t.prop === prop);
}

/** キーを打つ（同じ時刻にあれば値を上書き） */
export function setKey(clip: Clip, node: string, prop: AnimProp, t: number, v: number) {
  let tr = findTrack(clip, node, prop);
  if (!tr) { tr = { node, prop, keys: [] }; clip.tracks.push(tr); }
  const k = tr.keys.find((x) => Math.abs(x.t - t) < 1e-3);
  if (k) k.v = v;
  else { tr.keys.push({ t, v, ease: 'smooth' }); tr.keys.sort((a, b) => a.t - b.t); }
}

export function removeKey(clip: Clip, node: string, prop: AnimProp, t: number) {
  const tr = findTrack(clip, node, prop);
  if (!tr) return;
  tr.keys = tr.keys.filter((k) => Math.abs(k.t - t) >= 1e-3);
  if (!tr.keys.length) clip.tracks = clip.tracks.filter((x) => x !== tr);
}

/**
 * 揺れ：振れ幅 amp で往復する動きを、クリップ全体にわたって作る（既存のキーは置き換える）。
 * 周期はクリップの長さを割り切れるように調整するので、ループしても途切れない。
 * 揺れのキーは細かく並ぶ（あとから振れ幅を変えたいときは、もう一度揺れを付け直す）。
 * phase（0〜1）で揺れ始めのタイミングをずらせる（髪の房ごとにずらすと自然になる）。
 */
export function addWiggle(clip: Clip, node: string, prop: AnimProp, amp: number, period: number, phase: number) {
  const base = propDef(prop);
  const cycles = Math.max(1, Math.round(clip.duration / Math.max(0.05, period)));
  const P = clip.duration / cycles;
  // 1周期を12等分した点を等速でつなぐ（正弦波との差は振れ幅の数%で、ループのつなぎ目でも止まらない）
  const shift = (((phase % 1) + 1) % 1) * P;
  const steps = cycles * 12;
  const keys: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (clip.duration * i) / steps;
    keys.push({ t: +t.toFixed(4), v: +(base + amp * Math.sin(((t - shift) / P) * Math.PI * 2)).toFixed(4), ease: 'linear' });
  }
  const existing = findTrack(clip, node, prop);
  if (existing) existing.keys = keys;
  else clip.tracks.push({ node, prop, keys });
}

// ── 変換

const mul = (m: Affine, n: Affine): Affine => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c || 1e-12;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}

/** パーツ自身の変換（親の座標系で） */
export function localMatrix(pivot: Vec, p: Pose): Affine {
  const r = (p.rotate * Math.PI) / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  // T(pivot + 移動) · R · S · T(-pivot)
  const a = cs * p.scaleX, b = sn * p.scaleX, c = -sn * p.scaleY, d = cs * p.scaleY;
  return { a, b, c, d, e: pivot.x + p.x - (a * pivot.x + c * pivot.y), f: pivot.y + p.y - (b * pivot.x + d * pivot.y) };
}

/** パーツの中身の範囲 */
function nodeBounds(n: LayerNode): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const addPt = (p: Vec) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
  const walk = (x: LayerNode) => {
    if (x.kind === 'folder') { x.children.forEach(walk); return; }
    for (const s of x.shapes)
      for (const pr of shapePrims(s)) {
        if (pr.kind === 'line') { addPt(pr.a); addPt(pr.b); }
        else if (pr.kind === 'circle') { addPt({ x: pr.c.x - pr.r, y: pr.c.y - pr.r }); addPt({ x: pr.c.x + pr.r, y: pr.c.y + pr.r }); }
        else for (let i = 0; i <= 8; i++) addPt(cubicAt(pr.p0, pr.p1, pr.p2, pr.p3, i / 8));
      }
  };
  walk(n);
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** 中心点（指定がなければ中身の中央） */
export function pivotOf(n: LayerNode): Vec {
  if (n.pivot) return n.pivot;
  const b = nodeBounds(n);
  return b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : { x: 0, y: 0 };
}

export interface NodeState {
  /** ワールド（キャンバス）への変換 */
  m: Affine;
  opacity: number;
}

/** すべてのパーツの、ポーズを反映した変換と不透明度 */
export function nodeStates(doc: Doc, poses: Map<string, Pose>): Map<string, NodeState> {
  const out = new Map<string, NodeState>();
  const walk = (nodes: LayerNode[], parent: NodeState) => {
    for (const n of nodes) {
      const p = poses.get(n.id);
      const st: NodeState = p ? { m: mul(parent.m, localMatrix(pivotOf(n), p)), opacity: parent.opacity * p.opacity } : parent;
      out.set(n.id, st);
      if (n.kind === 'folder') walk(n.children, st);
    }
  };
  walk(doc.layers, { m: IDENTITY, opacity: 1 });
  return out;
}

/** 親の変換（パーツを動かすときの基準） */
export function parentState(doc: Doc, states: Map<string, NodeState>, id: string): NodeState {
  const at = findNode(doc, id);
  return (at?.parent && states.get(at.parent.id)) || { m: IDENTITY, opacity: 1 };
}

// ── 書き出し

/** アニメーションのデータ（ゲーム側で読み込む JSON） */
export function animJson(doc: Doc) {
  const parts: { id: string; name: string; parent: string | null; pivot: [number, number] }[] = [];
  const walk = (nodes: LayerNode[], parent: string | null) => {
    for (const n of nodes) {
      if (!n.visible) continue;
      const pv = pivotOf(n);
      parts.push({ id: n.id, name: n.name, parent, pivot: [+pv.x.toFixed(3), +pv.y.toFixed(3)] });
      if (n.kind === 'folder') walk(n.children, n.id);
    }
  };
  walk(doc.layers, null);
  const ids = new Set(parts.map((p) => p.id));
  return {
    format: 'personal-svg-maker-animation',
    version: 1,
    width: doc.width,
    height: doc.height,
    parts,
    clips: doc.animations.map((c) => ({
      name: c.name,
      duration: c.duration,
      loop: c.loop,
      tracks: c.tracks.filter((t) => ids.has(t.node) && t.keys.length).map((t) => ({ part: t.node, property: t.prop, keys: t.keys.map((k) => ({ t: k.t, v: k.v, ease: k.ease })) })),
    })),
  };
}

export const HANDOFF_GUIDE = `# アニメーション付き SVG の使い方

このデータは「Personal SVG Maker」で作ったものです。次の2つを組み合わせて再生します。

1. **パーツ SVG**：パーツ（レイヤー・フォルダー）ごとに \`<g id="パーツID" data-name="名前" data-pivot-x data-pivot-y>\` に分かれた SVG。フォルダーの \`<g>\` の中に、子パーツの \`<g>\` が入れ子になっています。塗りだけで、線（stroke）はありません。
2. **アニメーション JSON**：\`format: "personal-svg-maker-animation"\`。

## JSON の構造
- \`parts[]\`：\`id\`（SVG の \`<g id>\` と同じ）、\`name\`、\`parent\`（親パーツの id。一番上は null）、\`pivot\`（[x, y]。回転・拡大縮小の中心。SVG 全体の座標系での値）
- \`clips[]\`：\`name\`、\`duration\`（秒）、\`loop\`（true ならループ）、\`tracks[]\`
- \`tracks[]\`：\`part\`、\`property\`、\`keys[]\`（\`t\` 秒、\`v\` 値、\`ease\`）

## property の意味（すべて「描いたままの状態」からの変化）
| property | 意味 | 何もないときの値 |
|---|---|---|
| rotate | 回転（度、時計回りが正） | 0 |
| x, y | 移動量（SVG の座標と同じ単位） | 0 |
| scaleX, scaleY | 倍率 | 1 |
| opacity | 不透明度（0〜1、親と掛け合わせる） | 1 |

## 値の求め方（時刻 t）
- ループするクリップは \`t = t % duration\`。ループしないものは \`duration\` で止める。
- 最初のキーより前は最初のキーの値、最後のキーより後は最後のキーの値。
- キー a と次のキー b の間：\`u = (t - a.t) / (b.t - a.t)\`、\`v = a.v + (b.v - a.v) * f(u)\`。
  - \`ease\` は **キー a 側** の値を使う。
  - \`"smooth"\`：\`f(u) = u * u * (3 - 2 * u)\`（加速して減速）
  - \`"linear"\`：\`f(u) = u\`（等速）
  - \`"step"\`：\`f(u) = 0\`（次のキーの時刻で瞬時に切り替わる）

## 変換のかけ方
各パーツの \`<g>\` に、次の transform を設定します（pivot = [px, py]）。

\`\`\`
translate(px + x, py + y) rotate(rotate) scale(scaleX, scaleY) translate(-px, -py)
\`\`\`

\`<g>\` が入れ子になっているので、親パーツの動きは自動的に子パーツにも及びます。pivot は全パーツ共通の座標系（SVG 全体）で書かれていますが、親が動いていない状態での位置なので、上の式をそのまま各 \`<g>\` に入れれば正しく合成されます。opacity は \`<g>\` の opacity 属性に入れれば親と掛け合わさります。

## 参考：ブラウザでの再生コード（SVG を DOM に埋め込んだ場合）
\`\`\`js
function ease(e, u) { return e === 'step' ? 0 : e === 'linear' ? u : u * u * (3 - 2 * u); }
function sample(keys, t, def) {
  if (!keys.length) return def;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < b.t) return a.v + (b.v - a.v) * ease(a.ease, (t - a.t) / (b.t - a.t));
  }
  return keys[keys.length - 1].v;
}
const DEF = { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1 };
function applyClip(svgRoot, anim, clip, time) {
  const t = clip.loop ? time % clip.duration : Math.min(time, clip.duration);
  for (const part of anim.parts) {
    const v = { ...DEF };
    for (const tr of clip.tracks) if (tr.part === part.id) v[tr.property] = sample(tr.keys, t, DEF[tr.property]);
    const g = svgRoot.querySelector('#' + CSS.escape(part.id));
    if (!g) continue;
    const [px, py] = part.pivot;
    g.setAttribute('transform', \`translate(\${px + v.x} \${py + v.y}) rotate(\${v.rotate}) scale(\${v.scaleX} \${v.scaleY}) translate(\${-px} \${-py})\`);
    g.setAttribute('opacity', v.opacity);
  }
}
// 使い方：毎フレーム applyClip(svg, anim, anim.clips[0], 経過秒数)
\`\`\`

Canvas などで描く場合も、親から順に上の変換を掛け合わせてパーツを描けば同じ結果になります。
`;
