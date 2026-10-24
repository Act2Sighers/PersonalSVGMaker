/** 色は #rrggbb、または不透明度込みの #rrggbbaa で持つ */

export function splitColor(c: string): { hex: string; alpha: number } {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) return { hex: c, alpha: 1 };
  return { hex: '#' + m[1].toLowerCase(), alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

export function joinColor(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const base = splitColor(hex).hex;
  return a >= 0.999 ? base : base + Math.round(a * 255).toString(16).padStart(2, '0');
}

export const alphaPercent = (c: string) => Math.round(splitColor(c).alpha * 100);
