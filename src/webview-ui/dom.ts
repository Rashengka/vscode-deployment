/**
 * Turns the tree of `view.ts` into DOM nodes. Text becomes text nodes (never HTML), and only
 * the listed elements and attributes can be created: no script, no image or link, no `style`,
 * no `src`/`href` and no event handler attribute, whatever the tree contains.
 *
 * Written against the minimal interfaces below instead of the DOM types, so that it can be
 * tested without a browser; `document` satisfies them.
 */
import type { AttributeValue, ViewNode } from './view';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- any DOM node fits
export interface NodeLike {}

export interface ElementLike extends NodeLike {
  setAttribute(name: string, value: string): void;
  appendChild(node: NodeLike): unknown;
}

export interface DocumentLike {
  createElement(tag: string): ElementLike;
  createTextNode(text: string): NodeLike;
}

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'ul',
  'li',
  'nav',
  'section',
  'footer',
  'label',
  'input',
  'select',
  'option',
  'button',
  'details',
  'summary',
]);

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'class',
  'id',
  'type',
  'value',
  'placeholder',
  'title',
  'for',
  'role',
  'checked',
  'selected',
  'disabled',
  'hidden',
  'inputmode',
  'spellcheck',
  'autocomplete',
]);

/** `data-*` and `aria-*` with plain names. */
const PREFIXED_ATTRIBUTE = /^(data|aria)-[a-z]+$/;

export class UnsafeViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeViewError';
  }
}

function isAllowedAttribute(name: string): boolean {
  return ALLOWED_ATTRIBUTES.has(name) || PREFIXED_ATTRIBUTE.test(name);
}

function setAttribute(element: ElementLike, name: string, value: AttributeValue): void {
  if (!isAllowedAttribute(name)) {
    throw new UnsafeViewError(`The attribute "${name}" is not allowed in the settings view.`);
  }
  if (value === undefined || value === false) {
    return;
  }
  element.setAttribute(name, value === true ? '' : value);
}

export function createNode(doc: DocumentLike, node: ViewNode): NodeLike {
  if (typeof node === 'string') {
    return doc.createTextNode(node);
  }
  if (!ALLOWED_TAGS.has(node.tag)) {
    throw new UnsafeViewError(`The element "${node.tag}" is not allowed in the settings view.`);
  }
  const element = doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    setAttribute(element, name, value);
  }
  for (const child of node.children) {
    element.appendChild(createNode(doc, child));
  }
  return element;
}
