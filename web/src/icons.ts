import manifest from '../public/iconoir/manifest.json';

export type IconName = keyof typeof manifest.icons;

export function iconHref(name: IconName): string {
  return `/app/iconoir/sprite.svg#${name}`;
}

/** For short-lived DOM effects outside Vue. Names only come from the local catalog. */
export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'app-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', iconHref(name));
  svg.append(use);
  return svg;
}
