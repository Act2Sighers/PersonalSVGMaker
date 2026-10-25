import type { App, ToolId } from './app';
import type { Doc, Folder, MirrorAxis, ProjectFolder, Settings, Underlay } from './types';
import { ICONS } from './icons';
import { askConfirm, askText, el, escapeHtml, showInfo } from './dialogs';
import type { PickTool } from './tools/pick';
import type { UnderlayTool } from './tools/underlay';
import { collectImages, fitPlacement, importImageFile, storeImages } from './underlay';
import { buildLayersPanel } from './layers-panel';
import { buildTimeline } from './timeline';
import { allLayers, docToLineSvg, newDoc, newFolder, uid } from './doc';
import { docToSvg, gameHandoff } from './export';
import { animJson } from './anim';
import { deleteFolder, deleteProject, listFolders, listProjects, loadProject, saveFolder, saveProject } from './storage';
import { importSvg, type ImportResult } from './svg-import';

const TOOLS: { id: ToolId; label: string }[] = [
  { id: 'select', label: '選択' },
  { id: 'move', label: '移動' },
  { id: 'transform', label: '変形' },
  { id: 'line', label: '直線' },
  { id: 'bezier', label: '曲線' },
  { id: 'circle', label: '円' },
  { id: 'freehand', label: '手描き' },
  { id: 'fill', label: '塗り' },
];

function iconButton(icon: string, label: string, onClick: () => void, cls = 'icon-btn') {
  const b = el('button', cls, `${icon}<span>${label}</span>`);
  b.addEventListener('click', onClick);
  return b;
}

export interface UIRefs {
  canvas: HTMLCanvasElement;
  loupe: HTMLCanvasElement;
  stage: HTMLElement;
}

export function buildUI(root: HTMLElement, app: App): UIRefs {
  root.innerHTML = '';

  // ── 上部バー
  const top = el('header', 'topbar');
  const projBtn = iconButton(ICONS.menu, '作品', () => openProjects(app), 'icon-btn wide');
  const title = el('span', 'doc-title');
  const undoBtn = iconButton(ICONS.undo, '元に戻す', () => app.undo());
  const redoBtn = iconButton(ICONS.redo, 'やり直し', () => app.redo());
  const penBtn = iconButton(ICONS.pen, 'ペン', () => app.setMode('pen'), 'icon-btn mode');
  const handBtn = iconButton(ICONS.hand, 'ハンド', () => app.setMode('hand'), 'icon-btn mode');
  const fitBtn = iconButton(ICONS.fit, '全体表示（回転も戻す）', () => fitView());
  const exportBtn = iconButton(ICONS.export, '書き出し', () => openExport(app));
  const zoomLabel = el('span', 'zoom-label');
  const togglePanel = (p: HTMLElement) => {
    const open = !p.classList.contains('open');
    panel.classList.remove('open');
    layersPanel.classList.remove('open');
    p.classList.toggle('open', open);
    app.refreshUI();
  };
  const setBtn = iconButton(ICONS.settings, '設定', () => togglePanel(panel));
  const layersBtn = iconButton(ICONS.layers, 'レイヤー', () => togglePanel(layersPanel));
  const animBtn = iconButton(ICONS.anim, 'アニメ', () => {
    const on = !app.anim.active;
    app.setAnimActive(on);
  });
  const modeGroup = el('div', 'seg');
  modeGroup.append(penBtn, handBtn);
  top.append(projBtn, title, el('span', 'spacer'), undoBtn, redoBtn, el('span', 'vsep'), modeGroup, el('span', 'vsep'), fitBtn, zoomLabel, el('span', 'vsep'), animBtn, exportBtn, layersBtn, setBtn);

  // ── 左ツールバー
  const toolbar = el('nav', 'toolbar');
  const toolBtns = new Map<ToolId, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = iconButton(ICONS[t.id as keyof typeof ICONS], t.label, () => {
      app.setTool(t.id);
      if (app.mode === 'hand') app.setMode('pen');
    }, 'tool-btn');
    toolBtns.set(t.id, b);
    toolbar.append(b);
  }
  const poseBtn = iconButton(ICONS.anim, 'ポーズ', () => app.setTool('pose'), 'tool-btn');
  toolbar.append(poseBtn);

  // ── キャンバス
  const stage = el('div', 'stage');
  const canvas = el('canvas', 'main-canvas');
  const loupe = el('canvas', 'loupe');
  const options = el('div', 'options');
  const hint = el('div', 'hint');
  stage.append(canvas, loupe, options, hint);

  // ── 右パネル（設定）
  const panel = el('aside', 'panel');
  const syncPanel = buildSettingsPanel(panel, app);
  const layersPanel = el('aside', 'panel layers-panel');
  const syncLayers = buildLayersPanel(layersPanel, app);

  // ── タイムライン（アニメーション中だけ表示）
  const timeline = el('section', 'timeline');
  const syncTimeline = buildTimeline(timeline, app);
  const center = el('div', 'center');
  center.append(stage, timeline);

  const main = el('div', 'main');
  main.append(toolbar, center, panel, layersPanel);
  root.append(top, main);

  const fitView = () => {
    app.view.fit(app.doc.width, app.doc.height, stage.clientWidth, stage.clientHeight);
    app.refreshUI();
  };
  app.fitView = fitView;

  app.onUI = () => {
    title.textContent = app.doc.name;
    undoBtn.disabled = !app.history.canUndo;
    redoBtn.disabled = !app.history.canRedo;
    penBtn.classList.toggle('active', app.mode === 'pen');
    handBtn.classList.toggle('active', app.mode === 'hand');
    const deg = Math.round((app.view.rot * 180) / Math.PI);
    zoomLabel.textContent = `${Math.round(app.view.zoom * 100)}%${deg ? ` ${deg}°` : ''}`;
    for (const [id, b] of toolBtns) {
      b.classList.toggle('active', id === app.toolId);
      // アニメーション中は作図ツールを使わない（形を変えるときはアニメを終える）
      b.hidden = app.anim.active;
    }
    poseBtn.hidden = !app.anim.active;
    poseBtn.classList.toggle('active', app.toolId === 'pose');
    animBtn.classList.toggle('active', app.anim.active);
    timeline.hidden = !app.anim.active;
    if (app.anim.active) syncTimeline();
    options.replaceChildren(...app.tool.options());
    hint.textContent = app.mode === 'hand' ? 'ハンド：1本指でキャンバスを移動、2本指でズーム' : app.status || app.tool.hint();
    stage.classList.toggle('hand', app.mode === 'hand');
    syncPanel();
    setBtn.classList.toggle('active', panel.classList.contains('open'));
    layersBtn.classList.toggle('active', layersPanel.classList.contains('open'));
    if (layersPanel.classList.contains('open')) syncLayers();
  };

  return { canvas, loupe, stage };
}

function buildSettingsPanel(panel: HTMLElement, app: App): () => void {
  panel.innerHTML = '';
  const syncs: (() => void)[] = [];

  const section = (name: string) => {
    const s = el('section', 'panel-sec');
    s.append(el('h3', '', name));
    panel.append(s);
    return s;
  };
  const row = (parent: HTMLElement, label: string, input: HTMLElement) => {
    const r = el('label', 'row');
    r.append(el('span', '', label), input);
    parent.append(r);
  };
  const num = (parent: HTMLElement, label: string, get: () => number, set: (v: number) => void, min: number) => {
    const i = el('input');
    i.type = 'number';
    i.inputMode = 'decimal';
    i.min = String(min);
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (Number.isFinite(v) && v >= min) set(v);
      else i.value = String(get());
    });
    syncs.push(() => { if (document.activeElement !== i) i.value = String(+get().toFixed(3)); });
    row(parent, label, i);
  };
  const check = (parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void) => {
    const i = el('input');
    i.type = 'checkbox';
    i.addEventListener('change', () => set(i.checked));
    syncs.push(() => { i.checked = get(); });
    row(parent, label, i);
  };
  const docSet = (fn: (d: Doc) => void) => app.mutate(fn);
  const setSetting = <K extends keyof Settings>(k: K) => (v: Settings[K]) => app.updateSettings({ [k]: v } as Partial<Settings>);

  const g = section('グリッド');
  check(g, '表示', () => app.doc.grid.visible, (v) => docSet((d) => (d.grid.visible = v)));
  num(g, '間隔', () => app.doc.grid.spacing, (v) => docSet((d) => (d.grid.spacing = v)), 0.01);
  num(g, '太線（マスごと）', () => app.doc.grid.majorEvery, (v) => docSet((d) => (d.grid.majorEvery = Math.round(v))), 1);
  num(g, '基準点 X', () => app.doc.grid.originX, (v) => docSet((d) => (d.grid.originX = v)), -1e9);
  num(g, '基準点 Y', () => app.doc.grid.originY, (v) => docSet((d) => (d.grid.originY = v)), -1e9);
  const ob = el('div', 'row-btns');
  const pickOrigin = el('button', 'opt-btn', '基準点をタップで指定');
  pickOrigin.addEventListener('click', () => {
    panel.classList.remove('open');
    (app.tools.pick as PickTool).start('グリッドの基準点にする位置をタップ', (p) => app.mutate((d) => { d.grid.originX = p.x; d.grid.originY = p.y; }));
  });
  const resetOrigin = el('button', 'opt-btn', '左上に戻す');
  resetOrigin.addEventListener('click', () => docSet((d) => { d.grid.originX = 0; d.grid.originY = 0; }));
  ob.append(pickOrigin, resetOrigin);
  g.append(ob);

  const mi = section('ミラー描画');
  const axisSel = el('select', 'select-input');
  axisSel.id = 'mirror-axis';
  for (const [v, t] of [['none', 'オフ'], ['vertical', '縦の軸（左右対称）'], ['horizontal', '横の軸（上下対称）']]) {
    const o = el('option', '', t);
    o.value = v;
    axisSel.append(o);
  }
  axisSel.addEventListener('change', () => docSet((d) => (d.mirror.axis = axisSel.value as MirrorAxis)));
  syncs.push(() => { axisSel.value = app.doc.mirror.axis; });
  row(mi, '軸', axisSel);
  num(mi, '縦の軸の位置 X', () => app.doc.mirror.x, (v) => docSet((d) => (d.mirror.x = v)), -1e9);
  num(mi, '横の軸の位置 Y', () => app.doc.mirror.y, (v) => docSet((d) => (d.mirror.y = v)), -1e9);
  const mb = el('div', 'row-btns');
  const pickAxis = el('button', 'opt-btn', '軸の位置をタップで指定');
  pickAxis.addEventListener('click', () => {
    panel.classList.remove('open');
    (app.tools.pick as PickTool).start('ミラーの軸が通る位置をタップ', (p) =>
      app.mutate((d) => { d.mirror.x = p.x; d.mirror.y = p.y; if (d.mirror.axis === 'none') d.mirror.axis = 'vertical'; }));
  });
  const centerAxis = el('button', 'opt-btn', 'キャンバスの中央に');
  centerAxis.addEventListener('click', () => docSet((d) => { d.mirror.x = d.width / 2; d.mirror.y = d.height / 2; }));
  mb.append(pickAxis, centerAxis);
  mi.append(mb, el('p', 'note', 'オンにすると、直線・曲線・円で描いた図形が軸で折り返した位置にも作られます。'));

  // ── 下書き画像
  const ud = section('下書き画像');
  const udList = el('div', 'underlay-list');
  const udAdd = el('button', 'opt-btn', '画像を読み込む');
  udAdd.addEventListener('click', async () => {
    const f = await pickFile('image/*');
    if (!f) return;
    try {
      const img = await importImageFile(f);
      const u: Underlay = { ...fitPlacement(app.doc, img.id, img.width, img.height), name: baseName(f), visible: true };
      app.mutate((d) => d.underlays.push(u));
    } catch (e) {
      await showInfo(`画像を読み込めませんでした（${(e as Error).message}）`);
    }
  });
  ud.append(udAdd, udList, el('p', 'note', '下書きは表示用で、SVGの書き出しには含まれません。'));
  let udSig = '';
  syncs.push(() => {
    const sig = JSON.stringify(app.doc.underlays);
    if (sig === udSig) return;
    udSig = sig;
    udList.replaceChildren(...app.doc.underlays.map((u) => {
      const row = el('div', 'underlay-row');
      const vis = el('input');
      vis.type = 'checkbox';
      vis.checked = u.visible;
      vis.title = '表示';
      vis.addEventListener('change', () => docSet((d) => { const x = d.underlays.find((y) => y.id === u.id); if (x) x.visible = vis.checked; }));
      const op = el('input', 'alpha-input');
      op.type = 'number'; op.min = '0'; op.max = '100'; op.step = '10';
      op.value = String(Math.round(u.opacity * 100));
      op.title = '不透明度（%）';
      op.addEventListener('change', () => {
        const v = Math.max(0, Math.min(100, Number(op.value)));
        if (Number.isFinite(v)) docSet((d) => { const x = d.underlays.find((y) => y.id === u.id); if (x) x.opacity = v / 100; });
      });
      const adjust = el('button', 'opt-btn', '位置');
      adjust.addEventListener('click', () => { panel.classList.remove('open'); (app.tools.underlay as UnderlayTool).begin({ kind: 'doc', id: u.id }); });
      const del = el('button', 'opt-btn danger', '削除');
      del.addEventListener('click', () => docSet((d) => (d.underlays = d.underlays.filter((y) => y.id !== u.id))));
      row.append(vis, el('span', 'underlay-name', escapeHtml(u.name)), op, el('span', '', '%'), adjust, del);
      return row;
    }));
  });

  const s = section('スナップ');
  const scopeSel = el('select', 'select-input');
  scopeSel.id = 'snap-scope';
  for (const [v, t] of [['layer', '選んでいるレイヤーだけ'], ['all', 'すべてのレイヤー']]) {
    const o = el('option', '', t);
    o.value = v;
    scopeSel.append(o);
  }
  scopeSel.addEventListener('change', () => app.updateSettings({ snapScope: scopeSel.value as Settings['snapScope'] }));
  syncs.push(() => { scopeSel.value = app.settings.snapScope; });
  row(s, '吸着の対象', scopeSel);
  check(s, 'グリッド', () => app.settings.snapGrid, setSetting('snapGrid'));
  check(s, '端点・中心', () => app.settings.snapPoints, setSetting('snapPoints'));
  check(s, '交点・接点', () => app.settings.snapIntersections, setSetting('snapIntersections'));
  check(s, '線上', () => app.settings.snapOnLine, setSetting('snapOnLine'));
  check(s, '垂線・接点（直前の点から）', () => app.settings.snapPerp, setSetting('snapPerp'));
  check(s, '延長線', () => app.settings.snapExtensions, setSetting('snapExtensions'));

  const c = section('キャンバス');
  num(c, '幅', () => app.doc.width, (v) => docSet((d) => (d.width = v)), 1);
  num(c, '高さ', () => app.doc.height, (v) => docSet((d) => (d.height = v)), 1);

  const v = section('表示');
  check(v, 'ルーペ（指の下を拡大）', () => app.settings.loupe, setSetting('loupe'));
  check(v, '線を表示', () => app.settings.showLines, setSetting('showLines'));

  return () => syncs.forEach((f) => f());
}

// ── 作品の管理

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_') || 'untitled';

function isDoc(x: unknown): x is Doc {
  const d = x as Doc;
  return !!d && d.version === 1 && Array.isArray(d.layers) && typeof d.width === 'number';
}

/** SVG 書き出し画面：プレビュー、コピー、ダウンロード */
export function openExport(app: App) {
  const overlay = el('div', 'modal-bg');
  const box = el('div', 'modal');
  overlay.append(box);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const head = el('div', 'modal-head');
  const closeBtn = el('button', 'opt-btn', '閉じる');
  closeBtn.addEventListener('click', close);
  head.append(el('h2', '', 'SVGを書き出す'), el('span', 'spacer'), closeBtn);

  const seam = el('input');
  seam.type = 'checkbox';
  seam.id = 'export-seam';
  seam.checked = true;
  const seamRow = el('label', 'row');
  seamRow.append(el('span', '', '隣り合う塗りの境目の隙間を目立たなくする'), seam);

  const preview = el('div', 'export-preview');
  const status = el('p', 'note');
  const svgText = () => docToSvg(app.doc, { seamFix: seam.checked });
  const update = () => {
    const svg = svgText();
    preview.innerHTML = `<img alt="書き出しのプレビュー" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`;
    const n = allLayers(app.doc).reduce((s, l) => s + l.fills.length, 0);
    status.textContent = `塗り ${n}個・${(new Blob([svg]).size / 1024).toFixed(1)} KB。線は範囲を決めるためのものなので、書き出しには含まれません。`;
  };
  seam.addEventListener('change', update);

  const actions = el('div', 'modal-actions');
  const act = (labelText: string, fn: () => void) => {
    const b = el('button', 'opt-btn', labelText);
    b.addEventListener('click', fn);
    actions.append(b);
  };
  act('SVGファイルを保存', () => download(`${safeName(app.doc.name)}.svg`, svgText(), 'image/svg+xml'));
  act('SVGのコードをコピー', () => {
    navigator.clipboard.writeText(svgText()).then(
      () => (status.textContent = 'コピーしました。ゲーム側の Claude Code にそのまま貼り付けて渡せます。'),
      () => (status.textContent = 'コピーできませんでした。「SVGファイルを保存」を使ってください。'),
    );
  });
  act('線画SVGを保存（確認用）', () => download(`${safeName(app.doc.name)}-lines.svg`, docToLineSvg(app.doc), 'image/svg+xml'));

  box.append(head, seamRow, preview, status, actions);
  if (app.doc.animations.length) {
    const anim = el('div', 'modal-group');
    const row = el('div', 'modal-actions');
    const a2 = (labelText: string, fn: () => void) => { const b = el('button', 'opt-btn', labelText); b.addEventListener('click', fn); row.append(b); };
    a2('ゲーム用にまとめてコピー', () => {
      navigator.clipboard.writeText(gameHandoff(app.doc)).then(
        () => (status.textContent = '説明・パーツSVG・アニメーションJSONをまとめてコピーしました。ゲーム側の Claude Code に貼り付けて「この説明に従って組み込んで」と頼めば使えます。'),
        () => (status.textContent = 'コピーできませんでした。下のボタンでファイルに保存してください。'),
      );
    });
    a2('アニメーションJSONを保存', () => download(`${safeName(app.doc.name)}.anim.json`, JSON.stringify(animJson(app.doc), null, 2), 'application/json'));
    a2('説明書を保存', () => download(`${safeName(app.doc.name)}-README.md`, gameHandoff(app.doc), 'text/markdown'));
    const clips = app.doc.animations.map((c) => `${c.name}（${c.duration}秒${c.loop ? '・ループ' : ''}）`).join('、');
    anim.append(el('span', 'group-label', `アニメーション：${escapeHtml(clips)}`), row);
    box.append(anim);
  }
  document.body.append(overlay);
  update();
}

const FOLDER_KEY = 'psm:projectFolder';
const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" opacity="0.85"><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

const baseName = (f: File) => f.name.replace(/\.[^.]+$/, '') || '無題';

/** SVG を読み込んだ結果の知らせ */
function importSummary(r: ImportResult) {
  const lines = [`図形 ${r.shapes}個・塗り ${r.fills}個を読み込みました。`];
  if (r.skipped.length) lines.push(`読み込めなかったもの：${r.skipped.join('、')}`);
  lines.push('線の太さや線の色は読み込みません（このツールでは線は塗りの範囲を決めるためだけに使います）。');
  return lines.join('\n');
}

/** 作品の一覧。作品はフォルダーに分けて整理できる（フォルダーの中にフォルダーも作れる）。 */
export async function openProjects(app: App) {
  await app.saveNow();
  let folderId: string | null = null;
  try { folderId = localStorage.getItem(FOLDER_KEY) || null; } catch { /* 保存できない環境 */ }
  const setFolder = (id: string | null) => {
    folderId = id;
    try { id ? localStorage.setItem(FOLDER_KEY, id) : localStorage.removeItem(FOLDER_KEY); } catch { /* 保存できない環境 */ }
  };

  const overlay = el('div', 'modal-bg');
  const box = el('div', 'modal projects');
  overlay.append(box);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const head = el('div', 'modal-head');
  const closeBtn = el('button', 'opt-btn', '閉じる');
  closeBtn.addEventListener('click', close);
  head.append(el('h2', '', '作品'), el('span', 'spacer'), closeBtn);

  const group = (title: string) => {
    const wrap = el('div', 'modal-group');
    const row = el('div', 'modal-actions');
    wrap.append(el('span', 'group-label', title), row);
    return { wrap, add: (label: string, fn: () => void) => { const b = el('button', 'opt-btn', label); b.addEventListener('click', fn); row.append(b); } };
  };

  const create = group('作る・開く');
  create.add('新規作成', async () => {
    const name = await askText('新しい作品の名前', '無題');
    if (name === null) return;
    const d = newDoc(name || '無題');
    d.folderId = folderId;
    app.loadDoc(d);
    await app.saveNow();
    app.fitView();
    close();
  });
  create.add('新しいフォルダー', async () => {
    const name = await askText('フォルダーの名前', '新しいフォルダー');
    if (!name) return;
    await saveFolder({ id: uid(), name, parentId: folderId, createdAt: Date.now() });
    render();
  });
  create.add('SVGから新しい作品', async () => {
    const f = await pickFile('.svg,image/svg+xml');
    if (!f) return;
    try {
      const r = importSvg(await f.text());
      const d = newDoc(baseName(f), r.width, r.height);
      if (r.nodes.length) {
        d.layers = r.nodes;
        d.activeId = allLayers(d).at(-1)!.id;
      }
      d.folderId = folderId;
      app.loadDoc(d);
      await app.saveNow();
      app.fitView();
      close();
      await showInfo(importSummary(r));
    } catch (e) {
      await showInfo(`このファイルは読み込めませんでした（${(e as Error).message}）`);
    }
  });
  create.add('作品ファイルを開く', async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!isDoc(d)) throw new Error();
      await storeImages((d as Doc & { images?: Record<string, string> }).images);
      delete (d as Doc & { images?: unknown }).images;
      d.id = uid(); // 既存の作品を上書きしないよう別の作品として開く
      d.folderId = folderId;
      app.loadDoc(d);
      await app.saveNow();
      app.fitView();
      close();
    } catch {
      await showInfo('このファイルは読み込めませんでした。このツールで保存した .svgmaker.json を選んでください。');
    }
  });

  const current = group('編集中の作品');
  current.add('名前を変更', async () => {
    const name = await askText('作品の名前', app.doc.name);
    if (!name) return;
    app.mutate((d) => (d.name = name));
    await app.saveNow();
    render();
  });
  current.add('SVGを読み込む', async () => {
    const f = await pickFile('.svg,image/svg+xml');
    if (!f) return;
    try {
      const r = importSvg(await f.text());
      if (!r.nodes.length) throw new Error('読み込める図形がありませんでした');
      // 読み込んだものは、フォルダーにまとめて一番上に置く
      const folder: Folder = { ...newFolder(baseName(f)), children: r.nodes };
      app.mutate((d) => { d.layers.push(folder); d.activeId = allLayers({ ...d, layers: [folder] }).at(-1)!.id; });
      close();
      await showInfo(importSummary(r));
    } catch (e) {
      await showInfo(`このファイルは読み込めませんでした（${(e as Error).message}）`);
    }
  });
  // 作品ファイルには下書き画像も含める
  current.add('作品ファイルに保存', async () => download(`${safeName(app.doc.name)}.svgmaker.json`, JSON.stringify({ ...app.doc, images: await collectImages(app.doc) }), 'application/json'));
  current.add('SVGを書き出す', () => { close(); openExport(app); });

  const crumbs = el('div', 'crumbs');
  const list = el('div', 'proj-list');
  box.append(head, create.wrap, current.wrap, el('p', 'note', '作品はこの端末のブラウザ内に自動保存されます。念のため「作品ファイルに保存」でも控えを取っておけます。'), crumbs, list);
  document.body.append(overlay);

  async function render() {
    const [folders, docs] = await Promise.all([listFolders(), listProjects()]);
    const byId = new Map(folders.map((f) => [f.id, f]));
    // 消えたフォルダーの中にいたら一番上に戻る
    if (folderId && !byId.has(folderId)) setFolder(null);

    const path: ProjectFolder[] = [];
    for (let f = folderId ? byId.get(folderId) : undefined; f; f = f.parentId ? byId.get(f.parentId) : undefined) path.unshift(f);
    const crumb = (label: string, id: string | null) => {
      const b = el('button', 'crumb' + (id === folderId ? ' current' : ''), escapeHtml(label));
      b.addEventListener('click', () => { setFolder(id); render(); });
      return b;
    };
    crumbs.replaceChildren(crumb('すべての作品', null), ...path.flatMap((f) => [el('span', 'crumb-sep', '›'), crumb(f.name, f.id)]));

    const inFolder = (id: string | null | undefined) => (id ?? null) === folderId;
    const countIn = (id: string) => docs.filter((d) => d.folderId === id).length + folders.filter((f) => f.parentId === id).length;
    const rowBtn = (label: string, fn: () => void, cls = 'opt-btn') => {
      const b = el('button', cls, label);
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    const folderRows = folders.filter((f) => inFolder(f.parentId)).map((f) => {
      const item = el('div', 'proj-item folder');
      const info = el('div', 'proj-info');
      info.append(el('b', '', `${FOLDER_ICON}<span>${escapeHtml(f.name)}</span>`), el('small', '', `${countIn(f.id)}項目`));
      item.addEventListener('click', () => { setFolder(f.id); render(); });
      item.append(
        info,
        rowBtn('名前を変更', async () => {
          const name = await askText('フォルダーの名前', f.name);
          if (name) { await saveFolder({ ...f, name }); render(); }
        }),
        rowBtn('削除', async () => {
          if (!(await askConfirm(`フォルダー「${f.name}」を削除しますか？中の作品とフォルダーは1つ上に移ります。`, '削除'))) return;
          for (const d of docs) if (d.folderId === f.id) await saveProjectMeta(app, d, f.parentId);
          for (const c of folders) if (c.parentId === f.id) await saveFolder({ ...c, parentId: f.parentId });
          await deleteFolder(f.id);
          render();
        }, 'opt-btn danger'),
      );
      return item;
    });

    const docRows = docs.filter((d) => inFolder(d.folderId)).map((d) => {
      const item = el('div', 'proj-item' + (d.id === app.doc.id ? ' current' : ''));
      const info = el('div', 'proj-info');
      const shapes = allLayers(d).reduce((n, l) => n + l.shapes.length, 0);
      info.append(el('b', '', escapeHtml(d.name)), el('small', '', `${new Date(d.updatedAt).toLocaleString()}・図形 ${shapes}`));
      const open = rowBtn(d.id === app.doc.id ? '編集中' : '開く', async () => {
        const full = await loadProject(d.id);
        if (!full) return;
        app.loadDoc(full);
        app.fitView();
        close();
      });
      open.disabled = d.id === app.doc.id;
      item.append(
        info,
        open,
        rowBtn('移動', async () => {
          const to = await chooseFolder(folders, d.folderId ?? null);
          if (to === undefined) return;
          await saveProjectMeta(app, d, to);
          render();
        }),
        rowBtn('複製', async () => {
          const full = await loadProject(d.id);
          if (!full) return;
          const now = Date.now();
          await saveProject({ ...structuredClone(full), id: uid(), name: `${full.name} のコピー`, createdAt: now, updatedAt: now });
          render();
        }),
        rowBtn('削除', async () => {
          if (!(await askConfirm(`「${d.name}」を削除しますか？元に戻せません。`, '削除'))) return;
          await deleteProject(d.id);
          if (d.id === app.doc.id) {
            const nd = newDoc();
            nd.folderId = folderId;
            app.loadDoc(nd);
            await app.saveNow();
          }
          render();
        }, 'opt-btn danger'),
      );
      return item;
    });

    list.replaceChildren(...folderRows, ...docRows);
    if (!folderRows.length && !docRows.length) list.append(el('p', 'note', 'このフォルダーは空です。'));
  }
  render();
}

/** 作品のフォルダーだけを書き換えて保存する（編集中の作品なら、編集中のものも合わせる） */
async function saveProjectMeta(app: App, d: Doc, folderId: string | null) {
  if (d.id === app.doc.id) {
    app.doc.folderId = folderId;
    await app.saveNow();
    return;
  }
  const full = await loadProject(d.id);
  if (full) await saveProject({ ...full, folderId });
}

/** 移動先のフォルダーを選ぶ。やめたら undefined */
function chooseFolder(folders: ProjectFolder[], current: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const bg = el('div', 'modal-bg top');
    const box = el('div', 'modal small');
    const list = el('div', 'proj-list');
    const done = (v: string | null | undefined) => { bg.remove(); resolve(v); };
    const add = (label: string, id: string | null, depth: number) => {
      const b = el('button', 'folder-choice' + (id === current ? ' current' : ''), `${id ? FOLDER_ICON : ''}<span>${escapeHtml(label)}</span>`);
      b.style.paddingLeft = `${10 + depth * 20}px`;
      b.disabled = id === current;
      b.addEventListener('click', () => done(id));
      list.append(b);
    };
    add('すべての作品（一番上）', null, 0);
    const walk = (parent: string | null, depth: number) => {
      for (const f of folders.filter((x) => x.parentId === parent)) { add(f.name, f.id, depth); walk(f.id, depth + 1); }
    };
    walk(null, 1);
    const cancel = el('button', 'opt-btn', 'キャンセル');
    cancel.addEventListener('click', () => done(undefined));
    const btns = el('div', 'modal-actions end');
    btns.append(cancel);
    box.append(el('h2', '', '移動先のフォルダー'), list, btns);
    bg.append(box);
    document.body.append(bg);
  });
}
