// Keep editable fields visible when either the visual or layout viewport shrinks.
// This observes geometry, not a device model or a claim that an IME is present.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MineralViewport = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const textTypes = new Set(['text','search','email','url','tel','password','number']);
  function editable(element) {
    if (!element || element.disabled || element.readOnly || element.isConnected === false) return false;
    const tag = String(element.tagName || '').toLowerCase();
    return tag === 'textarea' || (tag === 'input' && textTypes.has(element.type || 'text')) || element.isContentEditable === true;
  }
  function geometry(win) {
    const view = win.visualViewport;
    const positive = value => Number.isFinite(value) && value > 0;
    const width = positive(win.innerWidth) ? win.innerWidth : 0;
    const height = positive(view?.height) ? view.height : (positive(win.innerHeight) ? win.innerHeight : 0);
    return {width, height, top: Number.isFinite(view?.offsetTop) ? Math.max(0,view.offsetTop) : 0,
      scale: positive(view?.scale) ? view.scale : 1};
  }
  function start(win, doc) {
    let baseline = geometry(win), frame = null, alignFrame = null, alignRequested = false, stopped = false;
    const listeners = [], nav = doc.querySelector('.bottom-nav');
    const request = fn => win.requestAnimationFrame(fn);
    function compact(view, field) {
      const sameWidth = Math.abs(view.width-baseline.width) <= Math.max(4,baseline.width*0.02);
      const noZoom = Math.abs(view.scale-1) < 0.01 && Math.abs(baseline.scale-1) < 0.01;
      return !!field && sameWidth && noZoom && baseline.height-view.height >= Math.max(80,baseline.height*0.15);
    }
    function displacement(field) {
      const view = geometry(win), rect = field.getBoundingClientRect();
      if (!view.height || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.width <= 0 || rect.height <= 0) return 0;
      let top = view.top+12;
      let bottom = view.top+view.height-12;
      if (nav && win.getComputedStyle(nav).display !== 'none') {
        const bounds = nav.getBoundingClientRect();
        if (bounds.top < bottom && bounds.bottom > top) bottom = Math.max(top,bounds.top-12);
      }
      // Being inside the screen does not mean being inside a dialog's scrollport.
      // Intersect every clipping ancestor before deciding how far to scroll.
      for (let parent=field.parentElement; parent && parent!==doc.documentElement; parent=parent.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(win.getComputedStyle(parent).overflowY) || !parent.getBoundingClientRect || !(parent.clientHeight>0)) continue;
        const bounds=parent.getBoundingClientRect(), innerTop=bounds.top+(parent.clientTop||0);
        if (bounds.width>0 && bounds.height>0) {
          top=Math.max(top,innerTop+8);
          bottom=Math.min(bottom,innerTop+parent.clientHeight-8);
        }
      }
      // A very tall editor cannot fit completely: keep its beginning reachable.
      if (rect.height > bottom-top) return rect.top-top;
      if (rect.bottom > bottom) return rect.bottom-bottom;
      if (rect.top < top) return rect.top-top;
      return 0;
    }
    function keepVisible(field) {
      if (!editable(field) || doc.activeElement !== field || doc.visibilityState === 'hidden') return;
      let delta = displacement(field);
      if (Math.abs(delta) < 1) return;
      // A dialog has its own scroll container; do not scroll the background first.
      for (let parent=field.parentElement; parent && parent!==doc.documentElement; parent=parent.parentElement) {
        if (/auto|scroll/.test(win.getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
          parent.scrollTop += delta;
          delta = displacement(field);
          if (Math.abs(delta) < 1) return;
        }
      }
      win.scrollBy({top:delta,left:0,behavior:'auto'});
    }
    function update() {
      frame = null;
      if (stopped) return;
      const field = editable(doc.activeElement) ? doc.activeElement : null, view = geometry(win);
      if (!field && Math.abs(view.scale-1)<0.01 && view.height>0) {
        const sameWidth = Math.abs(view.width-baseline.width) <= Math.max(4,baseline.width*0.02);
        // Blur precedes the closing resize on some WebViews. Do not save the
        // still-compressed height as the next keyboard-free baseline.
        baseline = {...view,height:sameWidth ? Math.max(view.height,baseline.height) : view.height};
      }
      doc.body.classList.toggle('compact-editing',doc.visibilityState!=='hidden' && compact(view,field));
      const shouldAlign = alignRequested;
      alignRequested = false;
      if (alignFrame !== null) win.cancelAnimationFrame(alignFrame);
      alignFrame = null;
      if (shouldAlign && field) alignFrame = request(() => {alignFrame=null;if (!stopped) keepVisible(field);});
    }
    function schedule(align=false) {
      if (stopped) return;
      alignRequested = alignRequested || align;
      if (frame === null) frame = request(update);
    }
    function listen(target, event, align) {
      const fn = () => schedule(align);
      target?.addEventListener(event,fn);
      listeners.push([target,event,fn]);
    }
    listen(doc,'focusin',true); listen(doc,'focusout',false);
    listen(doc,'visibilitychange',true);
    listen(win,'resize',true); listen(win,'orientationchange',true);
    listen(win.visualViewport,'resize',true); listen(win.visualViewport,'scroll',false);
    schedule();
    return {stop() {
      stopped = true;
      for (const [target,event,fn] of listeners) target?.removeEventListener(event,fn);
      if (frame!==null) win.cancelAnimationFrame(frame);
      if (alignFrame!==null) win.cancelAnimationFrame(alignFrame);
      doc.body.classList.remove('compact-editing');
    }};
  }
  return {editable,geometry,start};
});
