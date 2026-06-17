import { mkdir, readdir, copyFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Committed snapshot of the generated Indigenous support layers. These live in the
// bcdatamapper submodule (version-controlled) so the PGMaps build can populate
// public/data/indigenous/ offline, without re-hitting the BC source services at deploy time.
// Refresh with `npm run indigenous:sync`, then commit the updated snapshot here.
export const SNAPSHOT_DIR = path.join(here, 'snapshot')

// Resolve the PGMaps public output dir. run-in-pgmaps.sh exports PGMAPS_ROOT; the
// fallback walks up from this file (…/vendor/bcdatamapper/datascrapers/bc/indigenous).
export function resolvePublicDir() {
  const root = process.env.PGMAPS_ROOT ?? path.join(here, '..', '..', '..', '..', '..')
  return path.join(root, 'public', 'data', 'indigenous')
}

export async function copySnapshotToPublic() {
  const dest = resolvePublicDir()
  const files = (await readdir(SNAPSHOT_DIR)).filter((file) => file.endsWith('.geojson') || file.endsWith('.json'))
  if (files.length === 0) {
    throw new Error(`No snapshot files in ${SNAPSHOT_DIR}. Run "npm run indigenous:sync" to generate them.`)
  }
  await mkdir(dest, { recursive: true })
  for (const file of files) {
    await copyFile(path.join(SNAPSHOT_DIR, file), path.join(dest, file))
  }
  return { dest, files }
}
