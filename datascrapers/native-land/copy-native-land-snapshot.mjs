import { copySnapshotToPublic } from './native-land-snapshot.mjs'

const { dest, files } = await copySnapshotToPublic()
console.log(`native-land: copied ${files.length} snapshot file(s) to ${dest}`)
