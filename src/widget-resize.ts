import { bridge } from './bridge';
import { t, onLanguageChange } from './i18n';

export function mountWidgetResize(container: HTMLElement, kind: 'small'|'medium') {
  const grip = document.createElement('button');
  grip.type = 'button'; grip.className = 'widget-resize';
  function label() { grip.title = grip.ariaLabel = t('위젯 크기 조절'); }
  label(); onLanguageChange(label); container.append(grip);
  let frame = 0, next = 0, pointer: number | null = null;
  let startX = 0, startY = 0, startWidth = 0;
  function widthAt(event: PointerEvent) {
    const dx = startX-event.screenX, dy = (startY-event.screenY)*(kind==='small'?1:2);
    return startWidth + (Math.abs(dx)>=Math.abs(dy)?dx:dy);
  }
  grip.onpointerdown = event => {
    if (event.button !== 0 || pointer !== null) return;
    event.preventDefault(); pointer = event.pointerId; grip.setPointerCapture(pointer);
    startX = event.screenX; startY = event.screenY; next = startWidth = window.innerWidth;
  };
  grip.onpointermove = event => {
    if (pointer !== event.pointerId) return;
    next = widthAt(event);
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; void bridge.resizeWidget(next,false); });
  };
  grip.onlostpointercapture = () => {
    if (pointer === null) return;
    pointer = null; cancelAnimationFrame(frame); frame = 0; void bridge.resizeWidget(next,true);
  };
  grip.onkeydown = event => {
    const grow = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!grow && event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return;
    event.preventDefault(); void bridge.resizeWidget(window.innerWidth+(grow?8:-8),true);
  };
}
