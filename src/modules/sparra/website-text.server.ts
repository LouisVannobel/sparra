import { parse, type DefaultTreeAdapterTypes } from 'parse5'

type Node = DefaultTreeAdapterTypes.Node
type Element = DefaultTreeAdapterTypes.Element

const hidden = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'form'])
const passageTags = new Set(['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'address', 'dt', 'dd'])
const fallbackTags = new Set(['div', 'section', 'article', 'main'])
const separatorTags = new Set([...passageTags, ...fallbackTags, 'br', 'hr', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'header', 'footer', 'nav', 'aside', 'figure', 'figcaption', 'pre', 'details', 'summary'])

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function children(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : []
}

function visibleText(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value
  if (isElement(node) && hidden.has(node.tagName)) return ''
  const text = children(node).map(visibleText).join('')
  return isElement(node) && separatorTags.has(node.tagName) ? ` ${text} ` : text
}

function clean(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function findFirst(node: Node, tag: string): Element | undefined {
  if (isElement(node) && node.tagName === tag) return node
  for (const child of children(node)) {
    const found = findFirst(child, tag)
    if (found) return found
  }
  return undefined
}

function isPassageChild(node: Node): boolean {
  return isElement(node) && (passageTags.has(node.tagName) || fallbackTags.has(node.tagName))
}

function isWholePassage(node: Element): boolean {
  if (passageTags.has(node.tagName)) return true
  if (!fallbackTags.has(node.tagName)) return false
  const nodes = children(node)
  const hasPassageChild = nodes.some(isPassageChild)
  const hasInlineContext = nodes.some(child => !isPassageChild(child) && clean(visibleText(child)) !== '')
  return !hasPassageChild || hasInlineContext
}

export function extractWebsiteText(html: string) {
  const document = parse(html)
  const title = clean(visibleText(findFirst(document, 'title') ?? findFirst(document, 'h1') ?? document))
  const passages: Array<{ id: string; text: string }> = []
  function visit(node: Node): void {
    if (isElement(node) && (hidden.has(node.tagName) || node.tagName === 'head')) return
    if (isElement(node) && isWholePassage(node)) {
      const text = clean(visibleText(node))
      if (text) passages.push({ id: `p${passages.length + 1}`, text })
      return
    }
    for (const child of children(node)) visit(child)
  }
  visit(findFirst(document, 'body') ?? document)
  return { title, passages }
}
