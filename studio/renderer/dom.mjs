// Inert DOM construction: text goes through text nodes only. There is no HTML
// string sink, no href/src/style attribute support and no event-handler attributes.
const SVG = 'http://www.w3.org/2000/svg';
const ATTR = /^(?:id|role|tabindex|type|for|name|placeholder|title|autocomplete|spellcheck|wrap|rows|maxlength|value|hidden|disabled|checked|readonly|lang|dir|data-[a-z-]+|aria-[a-z-]+)$/;

export function h(doc, tag, props = {}, ...children) {
  const element = doc.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = String(value);
    else if (key === 'on') for (const [name, handler] of Object.entries(value)) element.addEventListener(name, handler);
    else if (ATTR.test(key)) element.setAttribute(key, value === true ? '' : String(value));
    else throw new TypeError(`Unsupported DOM property ${key}`);
  }
  append(element, children);
  return element;
}
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'string' || typeof child === 'number' ? parent.ownerDocument.createTextNode(String(child)) : child);
  }
  return parent;
}
export function replace(parent, ...children) { parent.replaceChildren(); return append(parent, children); }

// Original 20x20 line icons, fixed path data only.
const ICONS = {
  folder: 'M2.5 5.5h5l1.5 2h8.5v8h-15z',
  plus: 'M10 4v12M4 10h12',
  play: 'M6.5 4.5l9 5.5-9 5.5z',
  stop: 'M5.5 5.5h9v9h-9z',
  hammer: 'M4 16l6-6M9 5l3-1.5 4 4L14.5 10l-1.5-1.5L11 10.5 8.5 8l2-2z',
  check: 'M4 10.5l4 4 8-9',
  eye: 'M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5zM10 8a2 2 0 100 4 2 2 0 000-4z',
  send: 'M3 10l14-6-5 13-2.5-5.5z',
  cancel: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  refresh: 'M15.5 8A6 6 0 104.8 13M15.5 3.5V8H11',
  key: 'M8 11.5a3.5 3.5 0 110-.01M10.5 10H17v2.5M14.5 10v2',
  chip: 'M6 6h8v8H6zM8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3',
};
export function icon(doc, name) {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'zk-icon');
  const path = doc.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.chip);
  svg.append(path);
  return svg;
}
export function button(doc, { label, iconName, onClick, kind = '', title, disabled = false, pressed }) {
  return h(doc, 'button', { type: 'button', class: `zk-btn ${kind}`.trim(), title, disabled, 'aria-pressed': pressed === undefined ? undefined : String(pressed), on: { click: onClick } },
    iconName ? icon(doc, iconName) : null, h(doc, 'span', { text: label }));
}
// Inert markdown-ish rendering: fenced code becomes <pre>, everything else plain text.
export function richText(doc, text) {
  const out = [];
  const parts = String(text).split(/```[^\n]*\n?/);
  parts.forEach((part, index) => {
    if (!part) return;
    out.push(index % 2 ? h(doc, 'pre', { class: 'zk-code' }, part.replace(/\n$/, '')) : h(doc, 'p', { class: 'zk-para' }, part));
  });
  return out;
}
