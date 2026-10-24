import type { App, ToolId } from './app';
import type { Doc, Settings } from './types';
import { ICONS } from './icons';
import { docToLineSvg, newDoc, uid } from './doc';
import { docToSvg } from './export';
import { deleteProject, listProjects, loadProject } from './storage';

const TOOLS: { id: ToolId; label: string }[] = [
  { id: 'select', label: '選択' },
  { id: 'move', label: '移動' },
  { id: 'line', label: '直線' },
  { id: 'bezier', label: '曲線' },
  { id: 'circle', label: '円' },
  { id: 'fill', label: '塗り' },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

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
  const fitBtn = iconButton(ICONS.fit, '全体表示', () => fitView());
  const exportBtn = iconButton(ICONS.export, '書き出し', () => openExport(app));
  const zoomLabel = el('span', 'zoom-label');
  const setBtn = iconButton(ICONS.settings, '設定', () => panel.classList.toggle('open'));
  const modeGroup = el('div', 'seg');
  modeGroup.append(penBtn, handBtn);
  top.append(projBtn, title, el('span', 'spacer'), undoBtn, redoBtn, el('span', 'vsep'), modeGroup, el('span', 'vsep'), fitBtn, zoomLabel, el('span', 'vsep'), exportBtn, setBtn);

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

  const main = el('div', 'main');
  main.append(toolbar, stage, panel);
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
    zoomLabel.textContent = `${Math.round(app.view.zoom * 100)}%`;
    for (const [id, b] of toolBtns) b.classList.toggle('active', id === app.toolId);
    options.replaceChildren(...app.tool.options());
    hint.textContent = app.mode === 'hand' ? 'ハンド：1本指でキャンバスを移動、2本指でズーム' : app.status || app.tool.hint();
    stage.classList.toggle('hand', app.mode === 'hand');
    syncPanel();
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
  pickOrigin.addEventListener('click', () => { app.setMode('pen'); app.setTool('origin'); panel.classList.remove('open'); });
  const resetOrigin = el('button', 'opt-btn', '左上に戻す');
  resetOrigin.addEventListener('click', () => docSet((d) => { d.grid.originX = 0; d.grid.originY = 0; }));
  ob.append(pickOrigin, resetOrigin);
  g.append(ob);

  const s = section('スナップ');
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

/** 画面内の入力ダイアログ（prompt の代わり） */
function askText(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const bg = el('div', 'modal-bg top');
    const box = el('form', 'modal small');
    const input = el('input', 'text-input');
    input.value = initial;
    input.id = 'ask-text';
    const btns = el('div', 'modal-actions end');
    const cancel = el('button', 'opt-btn', 'キャンセル');
    cancel.type = 'button';
    const ok = el('button', 'opt-btn active', 'OK');
    ok.type = 'submit';
    btns.append(cancel, ok);
    box.append(el('h2', '', escapeHtml(title)), input, btns);
    bg.append(box);
    document.body.append(bg);
    input.focus();
    input.select();
    const done = (v: string | null) => { bg.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(null));
    box.addEventListener('submit', (e) => { e.preventDefault(); done(input.value.trim()); });
  });
}

/** 画面内の確認ダイアログ（confirm の代わり） */
function askConfirm(message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const bg = el('div', 'modal-bg top');
    const box = el('div', 'modal small');
    const btns = el('div', 'modal-actions end');
    const cancel = el('button', 'opt-btn', 'キャンセル');
    const ok = el('button', 'opt-btn danger-fill', escapeHtml(okLabel));
    btns.append(cancel, ok);
    box.append(el('p', '', escapeHtml(message)), btns);
    bg.append(box);
    document.body.append(bg);
    const done = (v: boolean) => { bg.remove(); resolve(v); };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
  });
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
    const n = app.doc.layers.reduce((s, l) => s + l.fills.length, 0);
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
  document.body.append(overlay);
  update();
}

export async function openProjects(app: App) {
  await app.saveNow();
  const overlay = el('div', 'modal-bg');
  const box = el('div', 'modal');
  overlay.append(box);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const head = el('div', 'modal-head');
  head.append(el('h2', '', '作品'), el('span', 'spacer'));
  const closeBtn = el('button', 'opt-btn', '閉じる');
  closeBtn.addEventListener('click', close);
  head.append(closeBtn);

  const actions = el('div', 'modal-actions');
  const act = (label: string, fn: () => void) => {
    const b = el('button', 'opt-btn', label);
    b.addEventListener('click', fn);
    actions.append(b);
  };
  act('新規作成', async () => {
    const name = await askText('新しい作品の名前', '無題');
    if (name === null) return;
    const d = newDoc(name || '無題');
    app.loadDoc(d);
    app.saveNow();
    app.fitView();
    close();
  });
  act('名前を変更', async () => {
    const name = await askText('作品の名前', app.doc.name);
    if (!name) return;
    app.mutate((d) => (d.name = name));
    app.saveNow().then(render);
  });
  act('ファイルに保存', () => download(`${safeName(app.doc.name)}.svgmaker.json`, JSON.stringify(app.doc), 'application/json'));
  act('ファイルから開く', () => {
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (!isDoc(d)) throw new Error();
        d.id = uid(); // 既存の作品を上書きしないよう別の作品として開く
        app.loadDoc(d);
        await app.saveNow();
        app.fitView();
        close();
      } catch {
        await askConfirm('このファイルは読み込めませんでした。このツールで保存した .svgmaker.json を選んでください。', 'OK');
      }
    });
    input.click();
  });
  act('SVGを書き出す', () => { close(); openExport(app); });

  const list = el('div', 'proj-list');
  box.append(head, actions, el('p', 'note', '作品はこの端末のブラウザ内に自動保存されます。念のため「ファイルに保存」でも控えを取っておけます。'), list);
  document.body.append(overlay);

  async function render() {
    const docs = await listProjects();
    list.replaceChildren(
      ...docs.map((d) => {
        const item = el('div', 'proj-item' + (d.id === app.doc.id ? ' current' : ''));
        const info = el('div', 'proj-info');
        const shapes = d.layers.reduce((n, l) => n + l.shapes.length, 0);
        info.append(el('b', '', escapeHtml(d.name)), el('small', '', `${new Date(d.updatedAt).toLocaleString()}・図形 ${shapes}`));
        const open = el('button', 'opt-btn', d.id === app.doc.id ? '編集中' : '開く');
        open.disabled = d.id === app.doc.id;
        open.addEventListener('click', async () => {
          const full = await loadProject(d.id);
          if (!full) return;
          app.loadDoc(full);
          app.fitView();
          close();
        });
        const del = el('button', 'opt-btn danger', '削除');
        del.addEventListener('click', async () => {
          if (!(await askConfirm(`「${d.name}」を削除しますか？元に戻せません。`, '削除'))) return;
          await deleteProject(d.id);
          if (d.id === app.doc.id) {
            app.loadDoc(newDoc());
            await app.saveNow();
          }
          render();
        });
        item.append(info, open, del);
        return item;
      }),
    );
  }
  render();
}

const escapeHtml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
