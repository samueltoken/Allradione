'use strict';
const limits = {small:{min:112,max:176},medium:{min:272,max:460}};
function widgetDimensions(kind, requested) {
  const {min,max} = limits[kind];
  const width = Number.isFinite(requested) ? Math.round(Math.max(min,Math.min(max,requested))) : max;
  return {width,height:kind === 'medium' ? Math.round(width / 2) : width + 14};
}
function anchoredWidget(area, size) {
  return {...size,x:Math.round(area.x+area.width-size.width-20),y:Math.round(area.y+area.height-size.height-20)};
}
module.exports = {widgetDimensions,anchoredWidget};
