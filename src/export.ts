import type { Doc, Paint } from './types';
import { fillFace } from './fills';
import { renderTree } from './doc';
import { animJson, HANDOFF_GUIDE, pivotOf } from './anim';
import { faceToPathData } from './regions';

const n3 = (n: number) => String(+n.toFixed(3));

export interface ExportOptions {
  /** 隣り合う塗りの境目に背景が透けないよう、塗りと同じ色で縁を少し太らせる */
  seamFix: boolean;
}

/** 塗りだけの SVG（線は範囲を決めるためのものなので出力しない） */
export function docToSvg(doc: Doc, opts: ExportOptions): string {
  const defs: string[] = [];
  let gid = 0;
  const paintRef = (p: Paint): string => {
    if (p.type === 'solid') return p.color;
    const id = `grad${++gid}`;
    defs.push(
      `    <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n3(p.x1)}" y1="${n3(p.y1)}" x2="${n3(p.x2)}" y2="${n3(p.y2)}">` +
        `<stop offset="0" stop-color="${p.color}"/><stop offset="1" stop-color="${p.color2}"/></linearGradient>`,
    );
    return `url(#${id})`;
  };
  const body = renderTree(doc.layers, '  ', (l, ind) =>
    l.fills.flatMap((f) => {
      const face = fillFace(l, f);
      if (!face) return [];
      const paint = paintRef(f.paint);
      const seam = opts.seamFix ? ` stroke="${paint}" stroke-width="0.5" stroke-linejoin="round"` : '';
      return [`${ind}<path id="${f.id}" d="${faceToPathData(face)}" fill="${paint}" fill-rule="evenodd"${seam}/>`];
    }),
    // アニメーションがある作品では、各パーツの回転・拡大縮小の中心も書いておく
    (n) => {
      if (!doc.animations.length) return '';
      const p = pivotOf(n);
      return ` data-pivot-x="${n3(p.x)}" data-pivot-y="${n3(p.y)}"`;
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
