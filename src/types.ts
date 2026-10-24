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

export interface PathShape {
  id: string;
  type: 'path';
  closed: boolean;
  nodes: PathNode[];
}

export interface CircleShape {
  id: string;
  type: 'circle';
  cx: number;
  cy: number;
  r: number;
}

export type Shape = PathShape | CircleShape;

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  shapes: Shape[];
}

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
  layers: Layer[];
  createdAt: number;
  updatedAt: number;
}

/** アプリ全体の設定（作品ごとではない） */
export interface Settings {
  snapGrid: boolean;
  snapPoints: boolean;
  snapIntersections: boolean;
  snapOnLine: boolean;
  snapPerp: boolean;
  snapExtensions: boolean;
  loupe: boolean;
}

/**
 * 点の参照キー: `${shapeId}:${key}`
 *  - パス: n{i}=頂点, i{i}=入りハンドル, o{i}=出ハンドル
 *  - 円:   c=中心
 */
export type PointRef = string;
