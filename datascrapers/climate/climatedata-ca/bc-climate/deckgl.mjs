/** Browser/Node native-grid adapter. No Deck.gl dependency or embedded data.
 * Geometry and binary values are fetched on demand from a pinned R2 release.
 */
export async function fetchBytes(url, {signal} = {}) {
  const response = await fetch(url, {signal});
  if (!response.ok) throw new Error(`Climate fetch ${response.status}: ${url}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  // Supports both raw .gz objects and servers performing Content-Encoding decoding.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

async function json(url, options) {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url, options)));
}

export function tilesInBounds(grid, bounds) {
  if (!bounds) return grid.tiles;
  const [west,south,east,north] = bounds;
  return grid.tiles.filter(({bounds:b}) => b[0] <= east && b[2] >= west && b[1] <= north && b[3] >= south);
}

export function selectBand(product, selection) {
  const matches = product.bands.map((band, index) => ({band,index})).filter(({band}) =>
    Object.entries(selection).every(([key,value]) => band[key] === value));
  if (matches.length !== 1) throw new Error(`Select exactly one band; found ${matches.length}. Include horizon, percentile, measure, baseline and season as needed.`);
  return matches[0];
}

export function decodeTile(grid, tile, indices, bytes, product, bandIndex) {
  if (!Number.isInteger(bandIndex) || bandIndex < 0 || bandIndex >= product.bands.length) throw new Error('Invalid band index');
  if (indices.length !== tile.count || bytes.byteLength !== product.bands.length * tile.count * 8) throw new Error('Climate tile dimensions mismatch');
  const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const features = [];
  const band = product.bands[bandIndex];
  for (let i=0; i<indices.length; i++) {
    const value = values.getFloat64((bandIndex * tile.count+i)*8, true);
    if (!Number.isFinite(value)) continue;
    const cell = indices[i];
    if (!Number.isInteger(cell) || cell < 0 || cell >= tile.width*tile.height) throw new Error('Invalid grid cell index');
    const row = tile.row + Math.floor(cell/tile.width), col = tile.col + cell%tile.width;
    const west = Math.min(grid.xEdges[col],grid.xEdges[col+1]), east = Math.max(grid.xEdges[col],grid.xEdges[col+1]);
    const south = Math.min(grid.yEdges[row],grid.yEdges[row+1]), north = Math.max(grid.yEdges[row],grid.yEdges[row+1]);
    const id = `${grid.id}:${row}:${col}`;
    features.push({type:'Feature', id,
      properties:{cellId:id, value, units:band.units, indicator:product.id, horizon:band.horizon,
        percentile:band.percentile, measure:band.measure, baseline:band.baseline, season:band.season},
      geometry:{type:'Polygon',coordinates:[[[west,south],[east,south],[east,north],[west,north],[west,south]]]}});
  }
  return {type:'FeatureCollection', features};
}

export async function openClimate(manifestUrl, {signal, cacheEntries=24} = {}) {
  // Resolve latest.json once. Subsequent assets remain pinned to that release.
  let manifest = await json(manifestUrl, {signal});
  if (manifest.manifest) {
    manifestUrl = new URL(manifest.manifest, manifestUrl).href;
    manifest = await json(manifestUrl, {signal});
  }
  if (manifest.format !== 'bcdatamapper-native-grid-v1') throw new Error('Unsupported climate format');
  const base = new URL('.', manifestUrl);
  const cache = new Map();
  async function cached(path, parse, options={}) {
    const key = path;
    if (cache.has(key)) {
      const value=cache.get(key); cache.delete(key); cache.set(key,value); return value;
    }
    const value = await (parse ? json : fetchBytes)(new URL(path,base), options);
    cache.set(key,value);
    while (cache.size>cacheEntries) cache.delete(cache.keys().next().value);
    return value;
  }
  return {
    manifest, baseUrl:base.href,
    async product(id, options) {
      const item=manifest.products.find(p=>p.id===id);
      if (!item) throw new Error(`Unknown climate indicator: ${id}`);
      return cached(item.path,true,options);
    },
    async grid(id, options) {
      if (!manifest.grids[id]) throw new Error(`Unknown grid: ${id}`);
      return cached(manifest.grids[id].path,true,options);
    },
    async tile(product, grid, tile, selection, options) {
      const {index}=selectBand(product,selection);
      const item=product.tiles.find(t=>t.id===tile.id);
      if (!item) throw new Error(`Missing value tile: ${tile.id}`);
      const [geometry,bytes]=await Promise.all([cached(tile.geometry,true,options),cached(item.path,false,options)]);
      return decodeTile(grid,tile,geometry.indices,bytes,product,index);
    },
    async *visibleTiles(id, selection, bounds, options={}) {
      const product=await this.product(id,options), grid=await this.grid(product.grid,options);
      for (const tile of tilesInBounds(grid,bounds)) yield {id:tile.id, data:await this.tile(product,grid,tile,selection,options)};
    },
    clearCache() { cache.clear(); }
  };
}
