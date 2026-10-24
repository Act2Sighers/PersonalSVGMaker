export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export const escapeHtml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** 画面内の入力ダイアログ（prompt の代わり） */
export function askText(title: string, initial: string): Promise<string | null> {
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
export function askConfirm(message: string, okLabel: string): Promise<boolean> {
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

