/** Longitude/latitude polygon utilities shared by painting and globe picking. */
export type LonLat = readonly [number, number];
export interface GeoRing { points: LonLat[]; bounds: [number,number,number,number]; }
export interface GeoPolygon { rings: GeoRing[]; bounds: [number,number,number,number]; }
export interface GlobeCountry { code:string; name:string; polygons:GeoPolygon[]; center:LonLat; }

export function unwrapRing(input: readonly number[][], anchor?:number):GeoRing {
  const points:LonLat[] = [];
  let last = input[0]?.[0] ?? 0;
  for (const point of input) {
    let lon = point[0];
    while(lon-last>180) lon-=360;
    while(lon-last< -180) lon+=360;
    points.push([lon,point[1]]);
    last=lon;
  }
  if(anchor!==undefined && points.length) {
    const center = points.reduce((sum,p)=>sum+p[0],0)/points.length;
    const shift = Math.round((anchor-center)/360)*360;
    for(let i=0;i<points.length;i++) points[i]=[points[i][0]+shift,points[i][1]];
  }
  return {points,bounds: bounds(points)};
}
function bounds(points:LonLat[]):[number,number,number,number] {
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(const [lon,lat] of points){west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);}
  return [west,south,east,north];
}
export function preparePolygon(input: readonly number[][][]):GeoPolygon {
  const outside = unwrapRing(input[0] ?? []);
  const center = (outside.bounds[0]+outside.bounds[2])/2;
  return {rings:[outside,...input.slice(1).map(r=>unwrapRing(r,center))],bounds:outside.bounds};
}
function ringContains(ring:GeoRing,lon:number,lat:number):boolean {
  const [west,south,east,north]=ring.bounds;
  if(lon<west||lon>east||lat<south||lat>north)return false;
  let inside=false;
  const points=ring.points;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const [xi,yi]=points[i], [xj,yj]=points[j];
    if(((yi>lat)!==(yj>lat)) && (lon<(xj-xi)*(lat-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}
export function polygonContains(polygon:GeoPolygon,lon:number,lat:number):boolean {
  const center = (polygon.bounds[0]+polygon.bounds[2])/2;
  const localLon=lon+360*Math.round((center-lon)/360);
  return ringContains(polygon.rings[0],localLon,lat) && !polygon.rings.slice(1).some(ring=>ringContains(ring,localLon,lat));
}
export function countryAt(countries:GlobeCountry[],lon:number,lat:number):GlobeCountry|undefined {
  return countries.find(country=>country.polygons.some(p=>polygonContains(p,lon,lat)));
}
export function countryCenter(polygons:GeoPolygon[]):LonLat {
  // The largest polygon keeps overseas territories from moving the view away from the mainland.
  const largest=[...polygons].sort((a,b)=>area(b.rings[0])-area(a.rings[0]))[0];
  if(!largest)return [0,0];
  const [west,south,east,north]=largest.bounds;
  return [((west+east)/2+540)%360-180,(south+north)/2];
}
function area(ring:GeoRing):number {
  let sum=0;const p=ring.points;
  for(let i=0,j=p.length-1;i<p.length;j=i++)sum+=p[j][0]*p[i][1]-p[i][0]*p[j][1];
  return Math.abs(sum)/2;
}
