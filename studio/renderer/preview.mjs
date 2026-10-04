// Native GamePreview placement. The renderer never embeds game content itself; it
// only posts a finite, viewport-clamped rect for an approved previewHandle.
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MIN_PREVIEW = 16;

export function previewRect(rect, viewport) {
  const values = [rect?.left, rect?.top, rect?.width, rect?.height, viewport?.width, viewport?.height];
  if (!values.every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return null;
  const x = Math.max(0, Math.round(rect.left)), y = Math.max(0, Math.round(rect.top));
  const right = Math.min(Math.floor(viewport.width), Math.round(rect.left + rect.width));
  const bottom = Math.min(Math.floor(viewport.height), Math.round(rect.top + rect.height));
  const width = right - x, height = bottom - y;
  return width >= MIN_PREVIEW && height >= MIN_PREVIEW ? { x, y, width, height } : null;
}

export function createPreviewController({ nativeActions, getElement, win, onChange = () => {} }) {
  let handle = null, shown = false, lastKey = '', frame = 0, destroyed = false, generation = 0;
  const available = typeof nativeActions?.showPreview === 'function' && typeof nativeActions?.hidePreview === 'function';
  const hide = async () => {
    if (!shown) return;
    shown = false; lastKey = '';
    try { await nativeActions.hidePreview(); } catch { /* host may already have revoked it */ }
  };
  const fail = async () => { handle = null; generation++; await hide(); onChange({ status: 'unavailable', previewHandle: null }); };
  async function sync() {
    frame = 0;
    if (destroyed || !handle) return;
    const element = getElement();
    const visible = element?.isConnected && element.getClientRects().length > 0;
    const rect = visible ? previewRect(element.getBoundingClientRect(), { width: win.innerWidth, height: win.innerHeight }) : null;
    if (!rect) { await hide(); return; }
    const key = `${handle}:${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (key === lastKey) return;
    lastKey = key;
    const mine = generation;
    try { await nativeActions.showPreview({ previewHandle: handle, rect }); if (mine === generation) { shown = true; onChange({ status: 'shown', previewHandle: handle }); } }
    catch { if (mine === generation) await fail(); }
  }
  const schedule = () => { if (!frame && !destroyed && handle) frame = win.requestAnimationFrame(() => { sync(); }); };
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
  win.addEventListener('resize', schedule);
  win.addEventListener('scroll', schedule, true);
  return {
    available,
    show(previewHandle) {
      if (!available || !ID.test(previewHandle ?? '')) { fail(); return false; }
      if (previewHandle !== handle) { handle = previewHandle; lastKey = ''; generation++; }
      const element = getElement();
      if (observer && element) { observer.disconnect(); observer.observe(element); }
      schedule();
      return true;
    },
    refresh: schedule,
    async clear() { handle = null; generation++; await hide(); onChange({ status: 'none', previewHandle: null }); },
    async destroy() {
      destroyed = true; handle = null; generation++;
      if (frame) win.cancelAnimationFrame(frame);
      observer?.disconnect();
      win.removeEventListener('resize', schedule);
      win.removeEventListener('scroll', schedule, true);
      await hide();
    },
  };
}
