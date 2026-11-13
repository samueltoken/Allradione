import { t } from './i18n';

// Bind only the template's own text, before any listener names or messages arrive.
export function bindChatLabels(root: HTMLElement) {
  const spans: Array<[Text,string]> = [];
  const attributes: Array<[Element,string,string]> = [];
  const walker = document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (/[가-힣]/.test(node.data)) spans.push([node,node.data]);
  }
  for (const el of [root,...root.querySelectorAll('[aria-label],[title],[placeholder]')]) {
    for (const attr of ['aria-label','title','placeholder']) {
      const key = el.getAttribute(attr);
      if (key && /[가-힣]/.test(key)) attributes.push([el,attr,key]);
    }
  }
  function refresh() {
    for (const [node,key] of spans) node.data = t(key);
    for (const [el,attr,key] of attributes) el.setAttribute(attr,t(key));
  }
  refresh(); return refresh;
}
