import './style.css';
import { App } from './app';
import { buildUI } from './ui';
import { attachInput } from './input';
import { drawScene } from './render';
import { View } from './view';
import { newDoc } from './doc';
import { getLastProjectId, loadProject, loadSettings } from './storage';
import { SelectTool } from './tools/select';
import { MoveTool } from './tools/move';
import { LineTool } from './tools/line';
import { BezierTool } from './tools/bezier';
import { CircleTool } from './tools/circle';
import { PickTool } from './tools/pick';
import { TransformTool } from './tools/transform';
import { FillTool } from './tools/fill';

const LOUPE_SIZE = 150;
const LOUPE_ZOOM = 3;

async function start() {
  const app = new App(loadSettings());
  app.tools = {
    select: new SelectTool(app),
    move: new MoveTool(app),
    transform: new TransformTool(app),
    line: new LineTool(app),
    bezier: new BezierTool(app),
    circle: new CircleTool(app),
    fill: new FillTool(app),
    pick: new PickTool(app),
  };

  const { canvas, loupe, stage } = buildUI(document.getElementById('app')!, app);
  const ctx = canvas.getContext('2d')!;
  const lctx = loupe.getContext('2d')!;
  let dpr = window.devicePixelRatio || 1;

  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(stage.clientWidth * dpr);
    canvas.height = Math.round(stage.clientHeight * dpr);
    loupe.width = loupe.height = Math.round(LOUPE_SIZE * dpr);
    app.requestRender();
  };

  app.onRender = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    drawScene(ctx, app, app.view, { dpr, w, h });

    // ルーペ：指で隠れている所を、指の少し上に拡大表示する
    const focus = app.tool.focus();
    const finger = app.fingerAt;
    if (!app.settings.loupe || !focus || !finger) {
      loupe.style.display = 'none';
      return;
    }
    const lv = new View();
    lv.zoom = app.view.zoom * LOUPE_ZOOM;
    lv.panX = LOUPE_SIZE / 2 - focus.x * lv.zoom;
    lv.panY = LOUPE_SIZE / 2 - focus.y * lv.zoom;
    drawScene(lctx, app, lv, { dpr, w: LOUPE_SIZE, h: LOUPE_SIZE });
    let x = finger.x - LOUPE_SIZE / 2, y = finger.y - LOUPE_SIZE - 70;
    if (y < 8) y = finger.y + 70;
    x = Math.max(8, Math.min(w - LOUPE_SIZE - 8, x));
    loupe.style.display = 'block';
    loupe.style.transform = `translate(${x}px, ${y}px)`;
  };

  new ResizeObserver(resize).observe(stage);
  resize();
  attachInput(canvas, app);
  (window as unknown as { __app: App }).__app = app; // 動作確認用

  // iPad Safari のページ自体の拡大やスクロールを止める
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.target === canvas) e.preventDefault(); }, { passive: false });

  const lastId = getLastProjectId();
  const doc = (lastId && (await loadProject(lastId))) || newDoc();
  app.loadDoc(doc);
  app.fitView();
  await app.saveNow();

  window.addEventListener('pagehide', () => app.saveNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden) app.saveNow(); });
}

start();
