// Statistics Canada, Variant of SGC 2021 for North and South.
// https://www23.statcan.gc.ca/imdb/p3VD.pl?Function=getVD&TVD=1372103

export const NORTH_SOUTH_CLASSIFICATION_URL = 'https://www23.statcan.gc.ca/imdb/p3VD.pl?Function=getVD&TVD=1372103'

export const NORTHERN_CENSUS_DIVISION_UIDS = new Set([
  '1010',
  '1011',
  '2491',
  '2492',
  '2493',
  '2494',
  '2495',
  '2496',
  '2497',
  '2498',
  '2499',
  '3548',
  '3549',
  '3551',
  '3552',
  '3553',
  '3554',
  '3556',
  '3557',
  '3558',
  '3559',
  '3560',
  '4619',
  '4620',
  '4621',
  '4622',
  '4623',
  '4718',
  '4812',
  '4813',
  '4816',
  '4817',
  '4818',
  '4819',
  '5941',
  '5945',
  '5947',
  '5949',
  '5951',
  '5953',
  '5955',
  '5957',
  '5959',
])

export const NORTHERN_TERRITORY_UIDS = new Set(['60', '61', '62'])

export function classifyCsdNorthSouth(csdUid) {
  const normalized = String(csdUid ?? '').trim()
  if (!/^\d{7}$/.test(normalized)) {
    throw new Error(`Expected a seven-digit CSDUID, received "${normalized}"`)
  }

  return NORTHERN_TERRITORY_UIDS.has(normalized.slice(0, 2)) ||
    NORTHERN_CENSUS_DIVISION_UIDS.has(normalized.slice(0, 4))
    ? 'North'
    : 'South'
}
