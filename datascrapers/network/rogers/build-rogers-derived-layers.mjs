import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const TILE_DIR = path.join(SCRIPT_DIR, 'output', 'tiles')
const SYNC_MANIFEST_PATH = path.join(TILE_DIR, 'sync-manifest.json')

const SOURCE_LAYER = '4g5g'
const SUBTRACT_LAYER = '4g'
const DERIVED_LAYERS = [
  {
    id: '4g5g-only',
    label: 'Rogers 5G/5G+ only',
    style: 'derived_from_rog_ca_v202_4g5g_minus_4g',
    mode: 'combined',
  },
  {
    id: '5g-only',
    label: 'Rogers 5G only',
    style: 'derived_from_rog_ca_v202_4g5g_minus_4g_class_5g',
    mode: '5g',
  },
  {
    id: '5g-plus-only',
    label: 'Rogers 5G+ only',
    style: 'derived_from_rog_ca_v202_4g5g_minus_4g_class_5g_plus',
    mode: '5g-plus',
  },
]
const ROGERS_5G = [218, 41, 28]
const ROGERS_5G_PLUS = [95, 28, 21]

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function walkPngTiles(layerId) {
  const layerDir = path.join(TILE_DIR, layerId)
  const tiles = []
  for (const zEntry of await readdir(layerDir, { withFileTypes: true })) {
    if (!zEntry.isDirectory()) continue
    const z = Number(zEntry.name)
    if (!Number.isInteger(z)) continue
    for (const xEntry of await readdir(path.join(layerDir, zEntry.name), { withFileTypes: true })) {
      if (!xEntry.isDirectory()) continue
      const x = Number(xEntry.name)
      if (!Number.isInteger(x)) continue
      for (const yEntry of await readdir(path.join(layerDir, zEntry.name, xEntry.name), { withFileTypes: true })) {
        if (!yEntry.isFile() || !yEntry.name.endsWith('.png')) continue
        const y = Number(yEntry.name.replace(/\.png$/, ''))
        if (!Number.isInteger(y)) continue
        tiles.push({
          z,
          x,
          y,
          sourcePath: path.join(layerDir, zEntry.name, xEntry.name, yEntry.name),
          subtractPath: path.join(TILE_DIR, SUBTRACT_LAYER, String(z), String(x), yEntry.name),
        })
      }
    }
  }
  return tiles.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y)
}

function similarPixel(source, subtract, index) {
  const alphaDelta = Math.abs(source.data[index + 3] - subtract.data[index + 3])
  const colorDelta =
    Math.abs(source.data[index] - subtract.data[index]) +
    Math.abs(source.data[index + 1] - subtract.data[index + 1]) +
    Math.abs(source.data[index + 2] - subtract.data[index + 2])
  return alphaDelta <= 8 && colorDelta <= 24
}

function isCoveragePixel(png, index) {
  const r = png.data[index]
  const g = png.data[index + 1]
  const b = png.data[index + 2]
  const a = png.data[index + 3]
  if (a < 16) return false
  // Rogers 5G/5G+ pixels are red/dark-red. This drops grey map artifacts.
  return r > b + 30 && r > g + 20
}

function colorDistanceSquared(png, index, color) {
  return (
    (png.data[index] - color[0]) ** 2 +
    (png.data[index + 1] - color[1]) ** 2 +
    (png.data[index + 2] - color[2]) ** 2
  )
}

function pixelClass(png, index) {
  const distanceTo5g = colorDistanceSquared(png, index, ROGERS_5G)
  const distanceTo5gPlus = colorDistanceSquared(png, index, ROGERS_5G_PLUS)
  return distanceTo5gPlus < distanceTo5g ? '5g-plus' : '5g'
}

function blankPngLike(source) {
  return new PNG({ width: source.width, height: source.height })
}

function copyPixel(source, target, index) {
  target.data[index] = source.data[index]
  target.data[index + 1] = source.data[index + 1]
  target.data[index + 2] = source.data[index + 2]
  target.data[index + 3] = source.data[index + 3]
}

async function writeLayerTile(tile, layer, png, nonTransparentPixels, manifest) {
  if (nonTransparentPixels === 0) {
    manifest.stats.skippedEmpty += 1
    return
  }

  const outputPath = path.join(TILE_DIR, layer.id, String(tile.z), String(tile.x), `${tile.y}.png`)
  const bytes = PNG.sync.write(png)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, bytes)
  manifest.stats.outputTiles += 1
  manifest.stats.bytesSaved += bytes.length
}

async function main() {
  const tiles = await walkPngTiles(SOURCE_LAYER)
  const manifests = DERIVED_LAYERS.map((layer) => ({
    generatedAt: new Date().toISOString(),
    provider: 'Rogers',
    layerId: layer.id,
    label: layer.label,
    method: `Pixel subtract ${SUBTRACT_LAYER} from ${SOURCE_LAYER}; remove non-red artifacts; classify by nearest Rogers legend color.`,
    sourceLayer: SOURCE_LAYER,
    subtractLayer: SUBTRACT_LAYER,
    stats: {
      sourceTiles: tiles.length,
      outputTiles: 0,
      skippedEmpty: 0,
      bytesSaved: 0,
    },
  }))

  for (const layer of DERIVED_LAYERS) {
    await rm(path.join(TILE_DIR, layer.id), { recursive: true, force: true })
  }

  for (const tile of tiles) {
    const source = PNG.sync.read(await readFile(tile.sourcePath))
    const subtract = await exists(tile.subtractPath)
      ? PNG.sync.read(await readFile(tile.subtractPath))
      : null

    const outputs = DERIVED_LAYERS.map((layer) => ({ layer, png: blankPngLike(source), pixels: 0 }))
    for (let i = 0; i < source.data.length; i += 4) {
      const shouldDrop =
        !isCoveragePixel(source, i) ||
        (subtract && similarPixel(source, subtract, i))

      if (shouldDrop) continue

      const klass = pixelClass(source, i)
      for (const output of outputs) {
        if (output.layer.mode !== 'combined' && output.layer.mode !== klass) continue
        copyPixel(source, output.png, i)
        output.pixels += 1
      }
    }

    for (const [index, output] of outputs.entries()) {
      await writeLayerTile(tile, output.layer, output.png, output.pixels, manifests[index])
    }
  }

  for (const [index, layer] of DERIVED_LAYERS.entries()) {
    await mkdir(path.join(TILE_DIR, layer.id), { recursive: true })
    await writeFile(path.join(TILE_DIR, layer.id, 'layer-download-manifest.json'), `${JSON.stringify(manifests[index], null, 2)}\n`)
  }

  if (await exists(SYNC_MANIFEST_PATH)) {
    const syncManifest = JSON.parse(await readFile(SYNC_MANIFEST_PATH, 'utf8'))
    const derivedIds = new Set(DERIVED_LAYERS.map((layer) => layer.id))
    syncManifest.layers = (syncManifest.layers ?? []).filter((layer) => !derivedIds.has(layer.layerId))
    syncManifest.layers.unshift(
      ...DERIVED_LAYERS.map((layer, index) => ({
        layerId: layer.id,
        label: manifests[index].label,
        style: layer.style,
        configuredZoomRange: { from: 1, to: 18 },
        stats: {
          downloaded: manifests[index].stats.outputTiles,
          bytesSaved: manifests[index].stats.bytesSaved,
          failed: 0,
        },
      })),
    )
    syncManifest.derivedLayers = {
      ...(syncManifest.derivedLayers ?? {}),
      ...Object.fromEntries(DERIVED_LAYERS.map((layer, index) => [
        layer.id,
        {
          sourceLayer: SOURCE_LAYER,
          subtractLayer: SUBTRACT_LAYER,
          method: manifests[index].method,
        },
      ])),
    }
    await writeFile(SYNC_MANIFEST_PATH, `${JSON.stringify(syncManifest, null, 2)}\n`)
  }
  for (const manifest of manifests) {
    console.log(`${manifest.layerId}: ${manifest.stats.outputTiles} tiles, ${(manifest.stats.bytesSaved / 1024 / 1024).toFixed(2)} MB`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
