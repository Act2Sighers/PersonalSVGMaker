import type { App } from './app';
import type { Doc, LayerNode } from './types';
import { cloneDoc, findNode } from './doc';
import { askConfirm, askText, el, escapeHtml } from './dialogs';
import { addFolder, addLayer, moveIntoFolderAbove, moveOutOfFolder, moveShapesToLayer, removeNode, shiftNode } from './layers';
import { selectedShapeIds } from './clipboard';

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
  panel.append(el('h3', 'panel-title', 'レイヤー'), list, actions);

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
  const moveHere = act('選択した図形をここへ', '選択中の図形（と、その図形だけで囲まれた塗り）を、このレイヤーへ移します', () => {
    const target = app.drawLayer();
    if (!target) return;
    const ids = selectedShapeIds(app.sel);
    let finish = () => {};
    app.mutate((d) => { finish = moveShapesToLayer(d, ids, target); }, { after: () => finish() });
    app.setStatus(`${ids.size}個の図形を「${target.name}」へ移しました`);
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
    if (n.kind === 'layer') name.append(el('small', '', `${n.shapes.length}`));
    r.append(name);
    r.addEventListener('click', () => {
      if (app.doc.activeId === n.id) return;
      app.doc.activeId = n.id;
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
    moveHere.disabled = !app.sel.size || findNode(app.doc, activeId())?.node.kind !== 'layer';
  };
}
