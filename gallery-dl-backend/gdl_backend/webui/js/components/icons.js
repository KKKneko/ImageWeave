/* 图标路径取自 Lucide（ISC），只内置桌面壳层所需的小型子集。 */
const ICON_PATHS = Object.freeze({
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="m3 6 .5.5L5 5"/><path d="m3 12 .5.5L5 11"/><path d="m3 18 .5.5L5 17"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M18 5l2 2M15 8l2 2"/>',
  images: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m7 16 3-3 2 2 3-4 3 5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  archive: '<path d="M3 6h18M5 6v14h14V6M9 10h6"/><rect x="2" y="3" width="20" height="3" rx="1"/>',
  minus: '<path d="M5 12h14"/>',
  square: '<rect x="4" y="4" width="16" height="16"/>',
  restore: '<rect x="3" y="7" width="14" height="14"/><path d="M7 7V3h14v14h-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
});

export function createIcon(name, { size = 24, strokeWidth = 1.7, className = "" } = {}) {
  const body = ICON_PATHS[name];
  if (!body) throw new Error(`未知图标：${name}`);

  const wrapper = document.createElement("span");
  wrapper.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${body}</svg>`;
  const icon = wrapper.firstElementChild;
  if (!(icon instanceof SVGElement)) throw new Error(`图标创建失败：${name}`);
  if (className) icon.setAttribute("class", className);
  return icon;
}
