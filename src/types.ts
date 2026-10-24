export interface Vec {
  x: number;
  y: number;
}

/** パスの頂点。ハンドルは絶対座標。null のときは直線（角）。 */
export interface PathNode {
  x: number;
  y: number;
  hin: Vec | null;
  hout: Vec | null;
}

/** グループ（入れ子にはしない）。同じ ID を持つ図形は常にまとめて選択される。 */
interface Groupable {
  group?: string;
}

export interface PathShape extends Groupable {
  id: string;
  type: 'path';
  closed: boolean;
  nodes: PathNode[];
}

export interface CircleShape extends Groupable {
  id: string;
  type: 'circle';
  cx: number;
  cy: number;
  r: number;
}

export type Shape = PathShape | CircleShape;

/** 色は #rrggbb、または不透明度込みの #rrggbbaa（不透明度が違えば別の色として扱う） */
export type Paint =
  | { type: 'solid'; color: string }
  /** 線形グラデーション。(x1,y1) で color、(x2,y2) で color2 */
  | { type: 'linear'; color: string; color2: string; x1: number; y1: number; x2: number; y2: number };

/** 塗り。範囲そのものは保存せず、毎回線から求め直す。seed はその範囲の内側の点。 */
export interface Fill {
  id: string;
  seed: Vec;
  paint: Paint;
}

export interface Layer {
  kind: 'layer';
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  shapes: Shape[];
  fills: Fill[];
  /** アニメーションで回転・拡大縮小の中心にする点（なければ中身の中央） */
  pivot?: Vec;
  /** 不透明度（0〜1、なければ 1） */
  opacity?: number;
}

export interface Folder {
  kind: 'folder';
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** レイヤー一覧で中身を開いているか */
  open: boolean;
  children: LayerNode[];
  pivot?: Vec;
  /** 不透明度（0〜1、なければ 1）。中身をまとめて描いてから薄くする */
  opacity?: number;
}

/** 下書き画像の置き場所（画像そのものは作品とは別に保存する） */
export interface UnderlayPlacement {
  id: string;
  /** 保存した画像の ID */
  image: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

export interface Underlay extends UnderlayPlacement {
  name: string;
  visible: boolean;
}

/** アニメーションの下書き：t 秒から次の下書きの時刻まで表示する */
export interface UnderlayFrame extends UnderlayPlacement {
  t: number;
}

export type LayerNode = Layer | Folder;

export interface GridSettings {
  originX: number;
  originY: number;
  spacing: number;
  /** 何マスごとに太い線を引くか */
  majorEvery: number;
  visible: boolean;
}

export interface Doc {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  grid: GridSettings;
  /** ミラー描画。vertical は x の位置の縦線、horizontal は y の位置の横線で折り返す */
  mirror: { axis: MirrorAxis; x: number; y: number };
  /** レイヤーとフォルダーの木。配列の先頭が一番下に描かれる。 */
  layers: LayerNode[];
  /** 描画先のレイヤー（またはレイヤー一覧で選んでいるフォルダー） */
  activeId: string;
  /** アニメーションのクリップ */
  animations: Clip[];
  /** 形を描くときの下書き画像（書き出しには含めない） */
  underlays: Underlay[];
  /** 作品一覧でのフォルダー（なければ一番上） */
  folderId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** アニメーションで動かせる値。回転は度、x・y は移動量、scaleX・scaleY は倍率、opacity は 0〜1 */
export type AnimProp = 'rotate' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'opacity';

/**
 * 次のキーまでのつなぎ方
 *  linear：全体で等速、step：瞬時（区間の最初に次の値へ一気に進み、あとは動かない）
 *  inOut：加速して中点から減速、in：加速、out：減速、circIn / circOut：円軌道で加速 / 減速
 */
export type Ease = 'linear' | 'step' | 'inOut' | 'in' | 'out' | 'circIn' | 'circOut';

export interface Keyframe {
  /** 秒 */
  t: number;
  v: number;
  ease: Ease;
  /** 加速・減速の鋭さ（2〜5。in・out・inOut で使う） */
  power?: number;
}

export interface Track {
  /** 動かすパーツ（レイヤーかフォルダー）の ID */
  node: string;
  prop: AnimProp;
  keys: Keyframe[];
}

export interface Clip {
  id: string;
  name: string;
  /** 秒 */
  duration: number;
  loop: boolean;
  tracks: Track[];
  /** アニメーションの下書き（時刻順） */
  underlays: UnderlayFrame[];
}

/** 作品一覧のフォルダー（作品の中のレイヤーフォルダーとは別） */
export interface ProjectFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

/** アプリ全体の設定（作品ごとではない） */
export type MirrorAxis = 'none' | 'vertical' | 'horizontal';

export interface Settings {
  snapGrid: boolean;
  snapPoints: boolean;
  snapIntersections: boolean;
  snapOnLine: boolean;
  snapPerp: boolean;
  snapExtensions: boolean;
  loupe: boolean;
  showLines: boolean;
  /** 吸着の対象：選んでいるレイヤーだけか、表示中のすべてのレイヤーか */
  snapScope: 'layer' | 'all';
}

/**
 * 点の参照キー: `${shapeId}:${key}`
 *  - パス: n{i}=頂点, i{i}=入りハンドル, o{i}=出ハンドル
 *  - 円:   c=中心
 */
export type PointRef = string;
