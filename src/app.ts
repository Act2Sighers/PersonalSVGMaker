import type { Doc, Layer, PointRef, Settings, Shape, Vec } from './types';
import { View } from './view';
import { History } from './history';
import { allShapes, cloneDoc, cloneShapes, layerEntries, mirrorMatrix, newDoc, normalizeDoc, pruneSelection, transformShape } from './doc';
import { reconcileFills, type TransformHint } from './fills';
import type { ClipData } from './clipboard';
import { SnapContext, type SnapOptions } from './snap';
import { saveProject, saveSettings, setLastProjectId } from './storage';

export type ToolId = 'select' | 'move' | 'transform' | 'line' | 'bezier' | 'circle' | 'freehand' | 'fill' | 'pick';
export type InputMode = 'pen' | 'hand';

export interface Tool {
  id: ToolId;
  activate?(): void;
  deactivate?(): void;
  down(screen: Vec): void;
  move(screen: Vec): void;
  up(screen: Vec): void;
  /** 2本指操作などで割り込まれたときに、押下中の操作だけを取り消す */
  cancelGesture(): void;
  /** 作図途中の状態ごと破棄する */
  reset?(): void;
  hint(): string;
  options(): HTMLElement[];
  overlay(ctx: CanvasRenderingContext2D, view: View): void;
  /** ルーペで拡大表示する点（指で押している間だけ） */
  focus(): Vec | null;
}

/** 指で触る前提のため、スナップや当たり判定は画面上で広めに取る */
export const TOUCH_TOL_PX = 22;

export class App {
  doc: Doc = newDoc();
  view = new View();
  history = new History();
  sel = new Set<PointRef>();
  mode: InputMode = 'pen';
  tools = {} as Record<ToolId, Tool>;
  toolId: ToolId = 'select';
  private prevToolId: ToolId = 'select';
  status = '';
  /** 指が触れている画面位置（ルーペ表示用） */
  fingerAt: Vec | null = null;
  /** コピーした図形と塗り */
  clipboard: ClipData | null = null;
  private renderQueued = false;
  private saveTimer = 0;
  onRender: () => void = () => {};
  onUI: () => void = () => {};
  fitView: () => void = () => {};

  constructor(public settings: Settings) {}

  get tool(): Tool {
    return this.tools[this.toolId];
  }

  setTool(id: ToolId) {
    if (id === this.toolId) return;
    this.tool.deactivate?.();
    this.prevToolId = this.toolId;
    this.toolId = id;
    this.tool.activate?.();
    this.refreshUI();
  }
  backToPrevTool() {
    this.setTool(this.prevToolId === this.toolId ? 'select' : this.prevToolId);
  }

  setMode(m: InputMode) {
    this.mode = m;
    this.refreshUI();
  }

  /** 描画先のレイヤー（表示用。編集できるかは問わない） */
  peekLayer(): Layer | null {
    return layerEntries(this.doc).find((x) => x.layer.id === this.doc.activeId)?.layer ?? null;
  }

  /** 描画先のレイヤー。フォルダーを選んでいる、またはロック・非表示のときは null（理由を表示する） */
  drawLayer(): Layer | null {
    const e = layerEntries(this.doc).find((x) => x.layer.id === this.doc.activeId);
    if (!e) {
      this.setStatus('描画先のレイヤーを、レイヤー一覧で選んでください');
      return null;
    }
    if (e.locked) { this.setStatus(`「${e.layer.name}」はロックされています`); return null; }
    if (!e.visible) { this.setStatus(`「${e.layer.name}」は非表示です`); return null; }
    return e.layer;
  }

  /** 図形を描画先のレイヤーに加える。ミラー描画がオンなら、折り返した図形も加える。 */
  addShape(s: Shape) {
    this.addShapes([s]);
  }
  addShapes(list: Shape[]) {
    const layer = this.drawLayer();
    if (!layer) return;
    const shapes = [...list];
    const m = mirrorMatrix(this.doc);
    if (m)
      for (const s of list) {
        const [c] = cloneShapes([s]);
        transformShape(c, m);
        // 折り返しても同じ形（軸上の円など）なら重ねない
        if (JSON.stringify({ ...c, id: s.id }) !== JSON.stringify(s)) shapes.push(c);
      }
    this.mutate(() => layer.shapes.push(...shapes));
  }

  /** 変更を履歴に残してから適用する。線が変わった場合は塗りを新しい範囲へ引き継ぐ。 */
  mutate(fn: (doc: Doc) => void, opts: { hint?: TransformHint; after?: (doc: Doc) => void } = {}) {
    const before = cloneDoc(this.doc);
    this.history.record(before);
    fn(this.doc);
    reconcileFills(before, this.doc, opts.hint);
    opts.after?.(this.doc);
    this.changed();
  }

  changed() {
    this.doc.updatedAt = Date.now();
    this.sel = pruneSelection(this.doc, this.sel);
    this.scheduleSave();
    this.refreshUI();
  }

  undo() {
    const d = this.history.undo(this.doc);
    if (!d) return;
    this.tool.reset?.();
    this.doc = d;
    this.changed();
  }
  redo() {
    const d = this.history.redo(this.doc);
    if (!d) return;
    this.tool.reset?.();
    this.doc = d;
    this.changed();
  }

  loadDoc(d: Doc) {
    this.tool.reset?.();
    this.doc = normalizeDoc(d);
    this.sel.clear();
    this.history.clear();
    setLastProjectId(d.id);
    this.refreshUI();
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 600);
  }
  async saveNow() {
    clearTimeout(this.saveTimer);
    await saveProject(this.doc);
    setLastProjectId(this.doc.id);
  }

  updateSettings(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.refreshUI();
  }

  /** 吸着の対象：設定に応じて、選んでいるレイヤーの図形だけか、表示中のすべての図形 */
  snapShapes(): Shape[] {
    if (this.settings.snapScope === 'all') return allShapes(this.doc);
    const e = layerEntries(this.doc).find((x) => x.layer.id === this.doc.activeId);
    return e?.visible ? e.layer.shapes : [];
  }
  snapContext(opts?: SnapOptions) {
    return new SnapContext(this.doc, this.settings, this.snapShapes(), opts);
  }
  get tol() {
    return TOUCH_TOL_PX / this.view.zoom;
  }

  setStatus(s: string) {
    this.status = s;
    this.onUI();
  }

  refreshUI() {
    this.onUI();
    this.requestRender();
  }
  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.onRender();
    });
  }
}
