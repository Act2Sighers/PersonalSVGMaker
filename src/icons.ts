const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  select: svg('<path d="M5 3l13 8-6 1.5L9 19z"/>'),
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  transform: svg('<rect x="5" y="5" width="14" height="14" stroke-dasharray="2.5 2"/><path d="M14 3.5a8.5 8.5 0 016.5 6.5M20.5 10l.3-3.2M20.5 10l-3-1"/><rect x="3" y="3" width="4" height="4" fill="currentColor"/><rect x="17" y="17" width="4" height="4" fill="currentColor"/>'),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  line: svg('<path d="M4 19L20 5"/><rect x="2.5" y="17.5" width="3" height="3" fill="currentColor"/><rect x="18.5" y="3.5" width="3" height="3" fill="currentColor"/>'),
  bezier: svg('<path d="M4 19C6 8 18 16 20 5"/><path d="M4 19L9 9M20 5l-4 9" stroke-dasharray="2 2"/><circle cx="9" cy="9" r="1.5"/><circle cx="16" cy="14" r="1.5"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  freehand: svg('<path d="M3 17c2-6 5-9 7-7s-1 6 2 6 4-9 9-10"/><circle cx="3" cy="17" r="1.2" fill="currentColor"/>'),
  fill: svg('<path d="M5 11l7-7 7 7-7 7z"/><path d="M19 14c1 1.6 1.5 2.6 1.5 3.3a1.5 1.5 0 01-3 0c0-.7.5-1.7 1.5-3.3z" fill="currentColor"/><path d="M5 11h14"/>'),
  anim: svg('<circle cx="12" cy="5" r="2.2"/><path d="M12 7.5v6M12 9.5l-4.5 3M12 9.5l4 -3.5M12 13.5l-3.5 6M12 13.5l3.5 6"/><path d="M18.5 15.5a3 3 0 012 2.5" opacity=".6"/>'),
  export: svg('<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 18v2h16v-2"/>'),
  pen: svg('<path d="M4 20l1-5L16 4l4 4L9 19z"/><path d="M14 6l4 4"/>'),
  hand: svg('<path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4-2.5 7-6 7s-5-2-6.5-4.5L3 12a1.5 1.5 0 012.5-1.5L8 13"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 000 10h3"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
};
