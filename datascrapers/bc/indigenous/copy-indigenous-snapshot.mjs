import { copySnapshotToPublic } from './indigenous-snapshot.mjs'

const { dest, files } = await copySnapshotToPublic()
console.log(`indigenous: copied ${files.length} snapshot file(s) to ${dest}`)
