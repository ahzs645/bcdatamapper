import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Committed snapshot of the Native Land Digital full GeoJSON API extract. These
// live in bcdatamapper so PGMaps can populate public/data/native-land/ offline.
// Refresh with `NATIVE_LAND_API_KEY=... npm run native-land:geojson`.
export const SNAPSHOT_DIR = path.join(here, 'snapshot')

export function resolvePublicDir() {
  const root = process.env.PGMAPS_ROOT ?? path.join(here, '..', '..', '..')
  return path.join(root, 'public', 'data', 'native-land')
}

export async function copySnapshotToPublic() {
  const dest = resolvePublicDir()
  const files = (await readdir(SNAPSHOT_DIR)).filter((file) => file.endsWith('.geojson') || file === 'manifest.json')
  if (files.length === 0) {
    throw new Error(`No Native Land snapshot files in ${SNAPSHOT_DIR}. Run "NATIVE_LAND_API_KEY=... npm run native-land:geojson" to refresh them.`)
  }
  await mkdir(dest, { recursive: true })
  for (const file of files) {
    await copyFile(path.join(SNAPSHOT_DIR, file), path.join(dest, file))
  }
  return { dest, files }
}
