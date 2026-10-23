import type { Doc } from './types';
import { cloneDoc } from './doc';

const LIMIT = 200;

/** 変更前の doc を丸ごと保存する単純な履歴 */
export class History {
  private undoStack: Doc[] = [];
  private redoStack: Doc[] = [];

  record(before: Doc) {
    this.undoStack.push(cloneDoc(before));
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(current: Doc): Doc | null {
    const d = this.undoStack.pop();
    if (!d) return null;
    this.redoStack.push(cloneDoc(current));
    return d;
  }
  redo(current: Doc): Doc | null {
    const d = this.redoStack.pop();
    if (!d) return null;
    this.undoStack.push(cloneDoc(current));
    return d;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}
