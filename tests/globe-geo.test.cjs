const test=require('node:test');
const assert=require('node:assert/strict');
let geo;
test.before(async()=>{geo=await import('../src/globe-geo.ts');});
test('country picking respects polygon holes',()=>{
 const polygon=geo.preparePolygon([[[0,0],[10,0],[10,10],[0,10],[0,0]],[[3,3],[7,3],[7,7],[3,7],[3,3]]]);
 assert.equal(geo.polygonContains(polygon,1,1),true);
 assert.equal(geo.polygonContains(polygon,5,5),false);
 assert.equal(geo.polygonContains(polygon,11,5),false);
});
test('country picking crosses the antimeridian without selecting the opposite hemisphere',()=>{
 const polygon=geo.preparePolygon([[[170,-10],[-170,-10],[-170,10],[170,10],[170,-10]]]);
 assert.equal(geo.polygonContains(polygon,179,0),true);
 assert.equal(geo.polygonContains(polygon,-179,0),true);
 assert.equal(geo.polygonContains(polygon,0,0),false);
});
test('mainland focus ignores a remote small territory',()=>{
 const big=geo.preparePolygon([[[10,20],[40,20],[40,60],[10,60],[10,20]]]);
 const small=geo.preparePolygon([[[-150,-20],[-149,-20],[-149,-19],[-150,-19],[-150,-20]]]);
 assert.deepEqual(geo.countryCenter([small,big]),[25,40]);
});
test('real map points identify countries on both sides of the date line',()=>{
 const atlas=require('world-atlas/countries-50m.json');
 const {feature}=require('topojson-client');const {numericToAlpha2}=require('i18n-iso-countries');
 const countries=feature(atlas,atlas.objects.countries).features.map(item=>{
  const polygons=(item.geometry.type==='Polygon'?[item.geometry.coordinates]:item.geometry.coordinates).map(geo.preparePolygon);
  return {code:numericToAlpha2(String(item.id).padStart(3,'0')),name:item.properties.name,polygons,center:geo.countryCenter(polygons)};
 });
 for(const [lon,lat,code] of [[126.98,37.56,'KR'],[139.69,35.68,'JP'],[-.127,51.507,'GB'],[-157.85,21.3,'US'],[178.45,-18.1,'FJ'],[103.85,1.35,'SG']]){
  assert.equal(geo.countryAt(countries,lon,lat)?.code,code);
 }
 assert.equal(geo.countryAt(countries,-145,0),undefined);
});
