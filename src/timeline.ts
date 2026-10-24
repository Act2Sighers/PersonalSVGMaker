import type { App } from './app';
import type { AnimProp, Clip, LayerNode } from './types';
import { findNode } from './doc';
import { addWiggle, EASES, findTrack, newClip, PROPS, removeKey, restPose, setKey } from './anim';
import { askConfirm, askText, el, escapeHtml } from './dialogs';
import type { PoseTool } from './tools/pose';

/**
 * タイムライン（アニメーション中、キャンバスの下に表示する）。
 * クリップの切り替え・再生・時刻の移動、選んでいるパーツのキーの表示と編集、揺れの追加。
 */
export function buildTimeline(root: HTMLElement, app: App): () => void {
  root.innerHTML = '';
  const controls = el('div', 'tl-row tl-controls');
  const scrubRow = el('div', 'tl-row');
  const tracks = el('div', 'tl-tracks');
  const keyRow = el('div', 'tl-row tl-key');
  root.append(controls, scrubRow, tracks, keyRow);

  const scrub = el('input', 'tl-scrub');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.step = '0.01';
  scrub.id = 'tl-scrub';
  scrub.addEventListener('input', () => { app.anim.playing = false; app.setTime(Number(scrub.value)); });
  const timeLabel = el('span', 'tl-time');
  scrubRow.append(scrub, timeLabel);

  let raf = 0, last = 0;
  const tick = (now: number) => {
    if (!app.anim.playing) return;
    const clip = app.currentClip();
    if (!clip) { app.anim.playing = false; return; }
    let t = app.anim.time + (now - last) / 1000;
    last = now;
    if (t >= clip.duration) {
      if (clip.loop) t %= clip.duration;
      else { t = clip.duration; app.anim.playing = false; }
    }
    app.setTime(t);
    if (app.anim.playing) raf = requestAnimationFrame(tick);
    else sync(true);
  };
  const play = () => {
    const clip = app.currentClip();
    if (!clip) return;
    app.anim.playing = !app.anim.playing;
    if (app.anim.playing) {
      if (!clip.loop && app.anim.time >= clip.duration) app.anim.time = 0;
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }
    sync(true);
  };

  const btn = (label: string, fn: () => void, opts: { active?: boolean; disabled?: boolean; cls?: string; title?: string } = {}) => {
    const b = el('button', 'opt-btn' + (opts.active ? ' active' : '') + (opts.cls ? ' ' + opts.cls : ''), escapeHtml(label));
    b.disabled = !!opts.disabled;
    if (opts.title) b.title = opts.title;
    b.addEventListener('click', fn);
    return b;
  };
  const editClip = (fn: (c: Clip) => void) => app.mutate((d) => { const c = d.animations.find((x) => x.id === app.currentClip()?.id); if (c) fn(c); });

  const ensureClip = () => {
    if (app.currentClip()) return;
    const c = newClip('待機');
    app.mutate((d) => d.animations.push(c));
    app.anim.clipId = c.id;
  };

  function buildControls(clip: Clip | null) {
    const sel = el('select', 'select-input');
    sel.id = 'tl-clip';
    for (const c of app.doc.animations) {
      const o = el('option', '', escapeHtml(c.name));
      o.value = c.id;
      sel.append(o);
    }
    if (!app.doc.animations.length) { const o = el('option', '', 'クリップなし'); o.value = ''; sel.append(o); }
    sel.value = clip?.id ?? '';
    sel.addEventListener('change', () => { app.anim.clipId = sel.value; app.anim.selKey = null; app.setTime(0); app.refreshUI(); });

    const dur = el('input', 'num-input');
    dur.type = 'number';
    dur.inputMode = 'decimal';
    dur.id = 'tl-duration';
    dur.min = '0.1';
    dur.step = '0.1';
    dur.value = String(clip?.duration ?? 2);
    dur.disabled = !clip;
    dur.addEventListener('change', () => {
      const v = Number(dur.value);
      if (!(v > 0)) return;
      editClip((c) => (c.duration = v));
      app.setTime(app.anim.time);
    });

    controls.replaceChildren(
      el('span', 'opt-label', 'クリップ'), sel,
      btn('＋', async () => {
        const name = await askText('新しいクリップの名前', app.doc.animations.length ? `動き ${app.doc.animations.length + 1}` : '待機');
        if (!name) return;
        const c = newClip(name);
        app.mutate((d) => d.animations.push(c));
        app.anim.clipId = c.id;
        app.setTime(0);
      }, { title: '新しいクリップ' }),
      btn('名前', async () => {
        if (!clip) return;
        const name = await askText('クリップの名前', clip.name);
        if (name) editClip((c) => (c.name = name));
      }, { disabled: !clip }),
      btn('削除', async () => {
        if (!clip || !(await askConfirm(`クリップ「${clip.name}」を削除しますか？`, '削除'))) return;
        app.mutate((d) => (d.animations = d.animations.filter((c) => c.id !== clip.id)));
        app.anim.clipId = null;
        app.setTime(0);
      }, { disabled: !clip, cls: 'danger' }),
      el('span', 'opt-sep'),
      el('span', 'opt-label', '長さ'), dur, el('span', 'opt-label', '秒'),
      btn('ループ', () => editClip((c) => (c.loop = !c.loop)), { active: !!clip?.loop, disabled: !clip }),
      el('span', 'opt-sep'),
      btn(app.anim.playing ? '■ 停止' : '▶ 再生', play, { disabled: !clip, active: app.anim.playing }),
      btn('先頭へ', () => { app.anim.playing = false; app.setTime(0); sync(true); }, { disabled: !clip }),
    );
  }

  /** 揺れを付けるダイアログ */
  function wiggleDialog(node: LayerNode) {
    ensureClip();
    const clip = app.currentClip()!;
    const bg = el('div', 'modal-bg top');
    const box = el('form', 'modal small');
    const field = (label: string, input: HTMLElement) => {
      const r = el('label', 'row');
      r.append(el('span', '', label), input);
      return r;
    };
    const prop = el('select', 'select-input');
    prop.id = 'wiggle-prop';
    for (const p of PROPS.filter((x) => x.id !== 'opacity')) { const o = el('option', '', p.label); o.value = p.id; prop.append(o); }
    const num = (id: string, v: number, step: string) => {
      const i = el('input', 'num-input');
      i.type = 'number'; i.inputMode = 'decimal'; i.id = id; i.step = step; i.value = String(v);
      return i;
    };
    const amp = num('wiggle-amp', 3, '0.1');
    const ampUnit = el('span', 'opt-label', '°');
    const period = num('wiggle-period', clip.duration, '0.1');
    const phase = num('wiggle-phase', 0, '0.05');
    const defaults: Record<string, [number, string]> = { rotate: [3, '°'], x: [2, ''], y: [2, ''], scaleX: [0.02, '倍'], scaleY: [0.02, '倍'] };
    prop.addEventListener('change', () => { const [v, u] = defaults[prop.value]; amp.value = String(v); ampUnit.textContent = u; });
    const ampWrap = el('span', 'tl-inline');
    ampWrap.append(amp, ampUnit);
    const btns = el('div', 'modal-actions end');
    const cancel = el('button', 'opt-btn', 'キャンセル');
    cancel.type = 'button';
    const ok = el('button', 'opt-btn active', '揺れを付ける');
    ok.type = 'submit';
    btns.append(cancel, ok);
    box.append(
      el('h2', '', `「${escapeHtml(node.name)}」に揺れを付ける`),
      field('動き', prop), field('振れ幅（中心からの片側）', ampWrap), field('1往復の時間（秒）', period), field('タイミングのずれ（0〜1）', phase),
      el('p', 'note', `クリップ「${escapeHtml(clip.name)}」（${clip.duration}秒）全体に、同じ動きの今のキーを置き換えて付けます。1往復の時間は、クリップの長さで割り切れるように調整されます。髪の房などはタイミングを少しずつずらすと自然になります。`),
      btns,
    );
    bg.append(box);
    document.body.append(bg);
    cancel.addEventListener('click', () => bg.remove());
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const a = Number(amp.value), per = Number(period.value), ph = Number(phase.value) || 0;
      if (!Number.isFinite(a) || !(per > 0)) return;
      app.mutate((d) => { const c = d.animations.find((x) => x.id === clip.id); if (c) addWiggle(c, node.id, prop.value as AnimProp, a, per, ph); });
      bg.remove();
      app.setStatus(`「${node.name}」に揺れを付けました。▶ 再生で確かめられます`);
    });
  }

  function buildTracks(clip: Clip | null) {
    const node = findNode(app.doc, app.doc.activeId)?.node ?? null;
    const rows: HTMLElement[] = [];
    const lane = (keys: { t: number }[], onKey: (t: number) => void, isSel: (t: number) => boolean) => {
      const l = el('div', 'tl-lane');
      const d = clip?.duration || 1;
      for (let s = 0; s <= d + 1e-9; s += 0.5) {
        const tick = el('span', 'tl-tick' + (Math.abs(s - Math.round(s)) < 1e-9 ? ' major' : ''));
        tick.style.left = `${(s / d) * 100}%`;
        l.append(tick);
      }
      for (const k of keys) {
        const dm = el('button', 'tl-keyframe' + (isSel(k.t) ? ' sel' : ''));
        dm.style.left = `${(k.t / d) * 100}%`;
        dm.title = `${k.t.toFixed(2)}秒`;
        dm.addEventListener('click', (e) => { e.stopPropagation(); onKey(k.t); });
        l.append(dm);
      }
      // 空いた所をタップすると、その時刻へ移る
      l.addEventListener('click', (e) => {
        const r = l.getBoundingClientRect();
        app.anim.playing = false;
        app.setTime(((e.clientX - r.left) / r.width) * d);
        sync(true);
      });
      l.append(el('span', 'tl-playhead'));
      return l;
    };
    if (node) {
      // 動きのある項目だけを並べる（キャンバスを広く使うため）
      for (const p of PROPS) {
        const tr = clip ? findTrack(clip, node.id, p.id) : undefined;
        if (!tr) continue;
        const r = el('div', 'tl-track');
        r.append(el('span', 'tl-name', p.label));
        r.append(lane(tr?.keys ?? [], (t) => {
          app.anim.selKey = { node: node.id, prop: p.id, t };
          app.anim.playing = false;
          app.setTime(t);
          sync(true);
        }, (t) => !!app.anim.selKey && app.anim.selKey.node === node.id && app.anim.selKey.prop === p.id && Math.abs(app.anim.selKey.t - t) < 1e-3));
        rows.push(r);
      }
    }
    // 他のパーツで動きのあるもの
    if (clip) {
      const others = [...new Set(clip.tracks.map((t) => t.node))].filter((id) => id !== node?.id);
      for (const id of others) {
        const n = findNode(app.doc, id)?.node;
        if (!n) continue;
        const keys = clip.tracks.filter((t) => t.node === id).flatMap((t) => t.keys);
        const r = el('div', 'tl-track other');
        const name = el('button', 'tl-name link', escapeHtml(n.name));
        name.title = 'このパーツを選ぶ';
        name.addEventListener('click', () => { app.doc.activeId = id; app.anim.selKey = null; app.refreshUI(); });
        r.append(name, lane(keys, (t) => { app.setTime(t); sync(true); }, () => false));
        rows.push(r);
      }
    }
    if (!rows.length)
      rows.push(el('p', 'note', node
        ? `「${escapeHtml(node.name)}」にはまだ動きがありません。キャンバスでなぞって動かすか、「揺れを付ける」を使ってください。`
        : 'キャンバスでパーツをタップするか、レイヤー一覧で動かすパーツを選んでください。'));
    else if (node && !PROPS.some((p) => clip && findTrack(clip, node.id, p.id)))
      rows.unshift(el('p', 'note', `「${escapeHtml(node.name)}」にはまだ動きがありません。`));
    tracks.replaceChildren(...rows);
  }

  /** 不透明度は指で動かせないので、数値でキーを打つ */
  function opacityInput(node: LayerNode) {
    const wrap = el('span', 'tl-inline');
    const i = el('input', 'num-input');
    i.type = 'number'; i.inputMode = 'decimal'; i.step = '0.1'; i.min = '0'; i.max = '1'; i.id = 'tl-opacity';
    i.value = String(+(app.poses().get(node.id)?.opacity ?? 1).toFixed(3));
    const set = btn('不透明度のキー', () => {
      const v = Math.max(0, Math.min(1, Number(i.value)));
      if (Number.isFinite(v)) (app.tools.pose as PoseTool).commitKeys(node.id, { ...restPose(), opacity: v }, ['opacity']);
    }, { title: '今の時刻に、入力した不透明度（0〜1）でキーを打ちます' });
    wrap.append(i, set);
    return wrap;
  }

  function buildKeyRow(clip: Clip | null) {
    const node = findNode(app.doc, app.doc.activeId)?.node ?? null;
    const items: HTMLElement[] = [];
    const sk = app.anim.selKey;
    const key = clip && sk ? findTrack(clip, sk.node, sk.prop)?.keys.find((k) => Math.abs(k.t - sk.t) < 1e-3) : undefined;
    if (node) {
      items.push(
        btn('キーを打つ', () => {
          const pose = { ...restPose(), ...(app.poses().get(node.id) ?? {}) };
          const used = PROPS.filter((p) => clip && findTrack(clip, node.id, p.id)).map((p) => p.id);
          (app.tools.pose as PoseTool).commitKeys(node.id, pose, used.length ? used : ['rotate', 'x', 'y']);
        }, { title: '今の時刻に、このパーツの今の値でキーを打ちます（動きの途中で止めたいときなど）' }),
        btn('揺れを付ける', () => wiggleDialog(node)),
        opacityInput(node),
        btn('このパーツの動きを消す', async () => {
          if (!clip || !(await askConfirm(`「${node.name}」のキーをすべて消しますか？`, '消す'))) return;
          editClip((c) => (c.tracks = c.tracks.filter((t) => t.node !== node.id)));
        }, { disabled: !clip?.tracks.some((t) => t.node === node.id), cls: 'danger' }),
      );
    }
    if (key && sk) {
      const p = PROPS.find((x) => x.id === sk.prop)!;
      const val = el('input', 'num-input');
      val.type = 'number'; val.inputMode = 'decimal'; val.step = 'any'; val.id = 'tl-key-value';
      val.value = String(key.v);
      val.addEventListener('change', () => {
        const v = Number(val.value);
        if (Number.isFinite(v)) editClip((c) => setKey(c, sk.node, sk.prop, sk.t, v));
      });
      items.push(el('span', 'opt-sep'), el('span', 'opt-label', `${p.label}のキー（${sk.t.toFixed(2)}秒）`), val);
      for (const e of EASES)
        items.push(btn(e.label, () => editClip((c) => { const k = findTrack(c, sk.node, sk.prop)?.keys.find((x) => Math.abs(x.t - sk.t) < 1e-3); if (k) k.ease = e.id; }), { active: key.ease === e.id, title: '次のキーまでのつなぎ方' }));
      items.push(btn('キーを削除', () => { editClip((c) => removeKey(c, sk.node, sk.prop, sk.t)); app.anim.selKey = null; }, { cls: 'danger' }));
    }
    keyRow.replaceChildren(...items);
  }

  let signature = '';
  /** 構造が変わったときだけ作り直し、時刻だけなら位置を更新する */
  function sync(force = false) {
    const clip = app.currentClip();
    const sig = JSON.stringify([clip, app.doc.activeId, app.anim.selKey, app.anim.playing, app.doc.animations.map((c) => [c.id, c.name])]);
    if (force || sig !== signature) {
      signature = sig;
      buildControls(clip);
      buildTracks(clip);
      buildKeyRow(clip);
    }
    const d = clip?.duration ?? 0;
    scrub.max = String(d);
    scrub.value = String(app.anim.time);
    scrub.disabled = !clip;
    timeLabel.textContent = `${app.anim.time.toFixed(2)} / ${d.toFixed(2)} 秒`;
    for (const ph of tracks.querySelectorAll<HTMLElement>('.tl-playhead')) ph.style.left = `${d ? (app.anim.time / d) * 100 : 0}%`;
  }
  app.onTime = () => sync();
  return sync;
}
