import type { App } from './app';
import type { Doc, LayerNode } from './types';
import { cloneDoc, findNode, layerEntries, pruneSelection } from './doc';
import { askConfirm, askText, el, escapeHtml } from './dialogs';
import { addFolder, addLayer, moveIntoFolderAbove, moveOutOfFolder, moveShapesToLayer, removeNode, shiftNode } from './layers';
import { selectedShapeIds } from './clipboard';
import { strokeLayer, type JoinStyle } from './outline';
import { joinColor, splitColor } from './color';

const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l18 18M10.6 6.1A10.7 10.7 0 0112 6c6.5 0 10 6 10 6a17 17 0 01-3.2 3.8M6.2 7.6A17 17 0 002 12s3.5 6 10 6c1.5 0 2.9-.3 4.1-.8"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';
const UNLOCK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" opacity="0.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/></svg>';
const FOLDER = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" opacity="0.8"><path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

/** レイヤー一覧（右側に重ねて表示する）。返り値は表示を更新する関数。 */
export function buildLayersPanel(panel: HTMLElement, app: App): () => void {
  panel.innerHTML = '';
  const list = el('div', 'layer-list');
  const actions = el('div', 'layer-actions');
  // 選んでいるレイヤー・フォルダーの不透明度
  const opRow = el('label', 'row');
  const op = el('input', 'alpha-input');
  op.type = 'number'; op.inputMode = 'numeric'; op.min = '0'; op.max = '100'; op.step = '5'; op.id = 'layer-opacity';
  op.addEventListener('change', () => {
    const v = Math.max(0, Math.min(100, Number(op.value)));
    if (!Number.isFinite(v)) return;
    app.mutate((d) => {
      const n = findNode(d, d.activeId)?.node;
      if (!n) return;
      if (v >= 100) delete n.opacity;
      else n.opacity = v / 100;
    });
  });
  const opWrap = el('span', 'tl-inline');
  opWrap.append(op, el('span', '', '%'));
  opRow.append(el('span', '', '不透明度（選んでいる項目）'), opWrap);
  panel.append(el('h3', 'panel-title', 'レイヤー'), list, opRow, actions);

  const act = (label: string, title: string, fn: () => void) => {
    const b = el('button', 'opt-btn', label);
    b.title = title;
    b.addEventListener('click', fn);
    actions.append(b);
    return b;
  };
  const activeId = () => app.doc.activeId;
  /** できない操作は履歴に残さず、理由を表示する */
  const tryMutate = (fn: (d: Doc) => boolean, fail: string) => {
    if (!fn(cloneDoc(app.doc))) return app.setStatus(fail);
    app.mutate((d) => fn(d));
  };

  act('＋レイヤー', '選んでいる項目の上に新しいレイヤーを作ります', () => app.mutate((d) => addLayer(d)));
  act('＋フォルダー', '選んでいる項目の上に新しいフォルダーを作ります', () => app.mutate((d) => addFolder(d)));
  act('名前を変更', '', async () => {
    const at = findNode(app.doc, activeId());
    if (!at) return;
    const name = await askText('名前', at.node.name);
    if (name) app.mutate((d) => (findNode(d, activeId())!.node.name = name));
  });
  act('↑', '一覧の上へ（手前に表示）', () => tryMutate((d) => shiftNode(d, activeId(), 1), 'これ以上は上へ動かせません'));
  act('↓', '一覧の下へ（奥に表示）', () => tryMutate((d) => shiftNode(d, activeId(), -1), 'これ以上は下へ動かせません'));
  act('上のフォルダーへ入れる', 'すぐ上にあるフォルダーの中へ入れます', () => tryMutate((d) => moveIntoFolderAbove(d, activeId()), 'すぐ上にフォルダーがありません'));
  act('フォルダーから出す', '', () => tryMutate((d) => moveOutOfFolder(d, activeId()), 'フォルダーの中にありません'));
  /** 「選択を別のレイヤーへ」を押したあと、移し先のレイヤーを選んでもらっている */
  let choosingTarget = false;
  const moveTo = act('選択を別のレイヤーへ', '選択中の図形（と、その図形だけで囲まれた塗り）を、次にタップしたレイヤーへ移します', () => {
    choosingTarget = !choosingTarget;
    app.setStatus(choosingTarget ? '移し先のレイヤーをタップしてください' : '');
    app.refreshUI();
  });
  const moveSelectionTo = (id: string) => {
    choosingTarget = false;
    const target = layerEntries(app.doc).find((e) => e.layer.id === id);
    if (!target) return app.setStatus('移し先にはレイヤーを選んでください');
    if (target.locked || !target.visible) return app.setStatus(`「${target.layer.name}」は${target.locked ? 'ロック' : '非表示に'}されています`);
    const ids = selectedShapeIds(app.sel);
    const sel = new Set(app.sel);
    let finish = () => {};
    app.mutate((d) => { finish = moveShapesToLayer(d, ids, target.layer); d.activeId = id; }, { after: () => finish() });
    // 移した図形を、移し先のレイヤーで選んだままにする
    app.sel = pruneSelection(app.doc, sel);
    app.setStatus(`${ids.size}個の図形を「${target.layer.name}」へ移しました`);
    app.refreshUI();
  };
  act('線を生成', '選んでいるレイヤーの線を、太さを持った色付きの線に置き換えたレイヤーを、すぐ上に作ります', () => {
    const at = findNode(app.doc, activeId());
    if (!at || at.node.kind !== 'layer') return app.setStatus('線を生成するレイヤーを選んでください');
    if (!at.node.shapes.length) return app.setStatus(`「${at.node.name}」には線がありません`);
    strokeDialog(app, at.node.id);
  });
  const del = act('削除', '', async () => {
    const at = findNode(app.doc, activeId());
    if (!at) return;
    const what = at.node.kind === 'folder' ? `フォルダー「${at.node.name}」と中身` : `レイヤー「${at.node.name}」`;
    if (!(await askConfirm(`${what}を削除しますか？`, '削除'))) return;
    tryMutate((d) => removeNode(d, at.node.id), '最後のレイヤーは削除できません');
  });
  del.classList.add('danger');

  const row = (n: LayerNode, depth: number, parentHidden: boolean) => {
    const r = el('div', 'layer-row' + (n.id === activeId() ? ' active' : '') + (parentHidden || !n.visible ? ' hidden-layer' : ''));
    r.style.paddingLeft = `${6 + depth * 18}px`;
    const toggle = (icon: string, title: string, fn: () => void) => {
      const b = el('button', 'layer-icon', icon);
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    const edit = (fn: (x: LayerNode) => void) => app.mutate((d) => fn(findNode(d, n.id)!.node));
    r.append(
      toggle(n.visible ? EYE : EYE_OFF, n.visible ? '非表示にする' : '表示する', () => edit((x) => (x.visible = !x.visible))),
      toggle(n.locked ? LOCK : UNLOCK, n.locked ? 'ロックを外す' : 'ロックする', () => edit((x) => (x.locked = !x.locked))),
    );
    if (n.kind === 'folder') {
      r.append(toggle(n.open ? '▾' : '▸', n.open ? '閉じる' : '開く', () => {
        // 開閉は作品の変更ではないので履歴に残さない
        const f = findNode(app.doc, n.id)!.node;
        if (f.kind === 'folder') f.open = !f.open;
        app.refreshUI();
      }));
    }
    const name = el('span', 'layer-name', (n.kind === 'folder' ? FOLDER : '') + `<span>${escapeHtml(n.name)}</span>`);
    if ((n.opacity ?? 1) < 1) name.append(el('small', 'layer-op', `${Math.round(n.opacity! * 100)}%`));
    if (n.kind === 'layer') name.append(el('small', '', `${n.shapes.length}`));
    r.append(name);
    r.addEventListener('click', () => {
      if (choosingTarget) return moveSelectionTo(n.id);
      if (app.doc.activeId === n.id) return;
      app.doc.activeId = n.id;
      // 選択できるのは選んでいるレイヤーの図形だけなので、切り替えたら選択を解除する
      app.sel.clear();
      app.scheduleSave();
      app.refreshUI();
    });
    return r;
  };

  return () => {
    const rows: HTMLElement[] = [];
    // 一覧は上が手前（描画順の逆）
    const walk = (nodes: LayerNode[], depth: number, hidden: boolean) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        rows.push(row(n, depth, hidden));
        if (n.kind === 'folder' && n.open) walk(n.children, depth + 1, hidden || !n.visible);
      }
    };
    walk(app.doc.layers, 0, false);
    list.replaceChildren(...rows);
    if (document.activeElement !== op) op.value = String(Math.round((findNode(app.doc, activeId())?.node.opacity ?? 1) * 100));
    if (!app.sel.size) choosingTarget = false;
    moveTo.disabled = !app.sel.size;
    moveTo.classList.toggle('active', choosingTarget);
    list.classList.toggle('choosing', choosingTarget);
  };
}

const STROKE_KEY = 'psm:strokeOptions';

/** 線の生成の設定画面：太さ・角と端の処理・色（不透明度込み） */
function strokeDialog(app: App, layerId: string) {
  let saved = { width: 4, style: 'round' as JoinStyle, color: '#000000' };
  try { saved = { ...saved, ...JSON.parse(localStorage.getItem(STROKE_KEY) ?? '{}') }; } catch { /* 保存できない環境 */ }
  const bg = el('div', 'modal-bg top');
  const box = el('form', 'modal small');
  const field = (label: string, input: HTMLElement) => {
    const r = el('label', 'row');
    r.append(el('span', '', label), input);
    return r;
  };
  const width = el('input', 'num-input');
  width.type = 'number'; width.inputMode = 'decimal'; width.min = '0.1'; width.step = 'any'; width.id = 'stroke-width';
  width.value = String(saved.width);
  const style = el('select', 'select-input');
  style.id = 'stroke-style';
  for (const [v, t] of [['round', '丸み'], ['sharp', 'シャープ']]) { const o = el('option', '', t); o.value = v; style.append(o); }
  style.value = saved.style;
  const { hex, alpha } = splitColor(saved.color);
  const color = el('input');
  color.type = 'color'; color.id = 'stroke-color'; color.value = hex;
  const op = el('input', 'alpha-input');
  op.type = 'number'; op.min = '0'; op.max = '100'; op.step = 'any'; op.id = 'stroke-opacity';
  op.value = String(Math.round(alpha * 100));
  const colorWrap = el('span', 'tl-inline');
  colorWrap.append(color, op, el('span', '', '%'));
  const btns = el('div', 'modal-actions end');
  const cancel = el('button', 'opt-btn', 'キャンセル');
  cancel.type = 'button';
  const ok = el('button', 'opt-btn active', '生成');
  ok.type = 'submit';
  btns.append(cancel, ok);
  const src = findNode(app.doc, layerId)?.node;
  box.append(
    el('h2', '', `「${escapeHtml(src?.name ?? '')}」の線を生成`),
    field('太さ', width), field('角と端', style), field('色・不透明度', colorWrap),
    el('p', 'note', '丸み：端は半円、角は丸く。シャープ：端は直角に切り落とし、角はとがらせます（とがった先が太さの4倍より長くなる所は平らに切り落とします）。結果は新しいレイヤーとして、このレイヤーのすぐ上に作ります。元の線を直しても、生成した線は変わりません。'),
    btns,
  );
  bg.append(box);
  document.body.append(bg);
  cancel.addEventListener('click', () => bg.remove());
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    const w = Number(width.value);
    if (!(w > 0)) return;
    const opts = { width: w, style: style.value as JoinStyle, color: joinColor(color.value, Math.max(0, Math.min(100, Number(op.value) || 0)) / 100) };
    try { localStorage.setItem(STROKE_KEY, JSON.stringify(opts)); } catch { /* 保存できない環境 */ }
    bg.remove();
    const layer = app.doc && findNode(app.doc, layerId)?.node;
    if (!layer || layer.kind !== 'layer') return;
    const made = strokeLayer(layer, opts);
    if (!made) return app.setStatus('線を生成できませんでした');
    app.mutate((d) => {
      const at = findNode(d, layerId);
      if (!at) return;
      at.siblings.splice(at.index + 1, 0, made);
      d.activeId = made.id;
    });
    app.setStatus(`「${made.name}」を作りました`);
  });
}
