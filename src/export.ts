import type { Doc, Paint } from './types';
import { fillFace } from './fills';
import { renderTree } from './doc';
import { animJson, HANDOFF_GUIDE, pivotOf } from './anim';
import { faceToPathData } from './regions';
import { splitColor } from './color';

const n3 = (n: number) => String(+n.toFixed(3));

export interface ExportOptions {
  /** 隣り合う塗りの境目に背景が透けないよう、塗りと同じ色で縁を少し太らせる */
  seamFix: boolean;
}

/** 塗りだけの SVG（線は範囲を決めるためのものなので出力しない） */
export function docToSvg(doc: Doc, opts: ExportOptions): string {
  const defs: string[] = [];
  let gid = 0;
  /** 塗りの属性（fill と、半透明なら fill-opacity）。opaque は完全に不透明か */
  const paintAttrs = (p: Paint): { fill: string; opacity: string; opaque: boolean } => {
    if (p.type === 'solid') {
      const { hex, alpha } = splitColor(p.color);
      return { fill: hex, opacity: alpha < 1 ? ` fill-opacity="${n3(alpha)}"` : '', opaque: alpha >= 1 };
    }
    const id = `grad${++gid}`;
    const a = splitColor(p.color), b = splitColor(p.color2);
    const stop = (offset: number, c: { hex: string; alpha: number }) =>
      `<stop offset="${offset}" stop-color="${c.hex}"${c.alpha < 1 ? ` stop-opacity="${n3(c.alpha)}"` : ''}/>`;
    defs.push(
      `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n3(p.x1)}" y1="${n3(p.y1)}" x2="${n3(p.x2)}" y2="${n3(p.y2)}">` +
        `${stop(0, a)}${stop(1, b)}</linearGradient>`,
    );
    return { fill: `url(#${id})`, opacity: '', opaque: a.alpha >= 1 && b.alpha >= 1 };
  };
  const body = renderTree(doc.layers, '  ', (l, ind) =>
    l.fills.flatMap((f) => {
      const face = fillFace(l, f);
      if (!face) return [];
      const p = paintAttrs(f.paint);
      // 半透明の塗りに縁を付けると境目が濃く見えるので、不透明な塗りだけにする
      const seam = opts.seamFix && p.opaque ? ` stroke="${p.fill}" stroke-width="0.5" stroke-linejoin="round"` : '';
      return [`${ind}<path id="${f.id}" d="${faceToPathData(face)}" fill="${p.fill}"${p.opacity} fill-rule="evenodd"${seam}/>`];
    }),
    (n) => {
      let a = '';
      // レイヤー・フォルダーの不透明度
      if ((n.opacity ?? 1) < 1) a += ` opacity="${n3(n.opacity!)}"`;
      // アニメーションがある作品では、各パーツの回転・拡大縮小の中心も書いておく
      if (doc.animations.length) {
        const p = pivotOf(n);
        a += ` data-pivot-x="${n3(p.x)}" data-pivot-y="${n3(p.y)}"`;
      }
      return a;
    },
  );
  const defsBlock = defs.length ? `  <defs>\n${defs.join('\n')}\n  </defs>\n` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${doc.width} ${doc.height}" width="${doc.width}" height="${doc.height}">\n${defsBlock}${body}\n</svg>\n`;
}

/** ゲーム側の Claude Code に渡すための、説明・パーツ SVG・アニメーション JSON をまとめた文章 */
export function gameHandoff(doc: Doc): string {
  return `${HANDOFF_GUIDE}
## パーツ SVG（${doc.name}）
\`\`\`svg
${docToSvg(doc, { seamFix: true }).trim()}
\`\`\`

## アニメーション JSON
\`\`\`json
${JSON.stringify(animJson(doc), null, 2)}
\`\`\`
`;
}
