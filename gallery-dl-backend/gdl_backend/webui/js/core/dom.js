export function requireElement(selector, root = document) {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`缺少桌面壳层元素：${selector}`);
  }
  return element;
}

export function createElement(tagName, options = {}, children = []) {
  const element = document.createElement(tagName);
  const { className, text, attributes = {}, dataset = {} } = options;

  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  }
  for (const [name, value] of Object.entries(dataset)) {
    if (value !== undefined && value !== null) element.dataset[name] = String(value);
  }

  for (const child of children) {
    if (child instanceof Node) element.append(child);
    else if (child !== undefined && child !== null) element.append(String(child));
  }
  return element;
}

export function setElementInert(element, inert) {
  element.toggleAttribute("inert", inert);
  element.inert = inert;
}
