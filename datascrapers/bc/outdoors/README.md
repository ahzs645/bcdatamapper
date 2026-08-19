# BC outdoor planning data

This pipeline assembles authoritative, public base layers for hunting and
fishing planning. It intentionally keeps two kinds of information separate:

- **Public reference layers** such as management units, legal closures and
  hydrography are normalized by `bcdatamapper`, tiled, and published to R2.
- **Personal plans** such as camps, possible access routes, range limits and
  scouting notes are imported locally and must not be uploaded to the public
  `maps` bucket.

The distinction comes directly from the supplied `MU-7-42.kml` planning
specimen. That file combines legal context, access constraints, formal public
access, unverified candidates and private planning annotations. Flattening all
of those into one undifferentiated layer would make the interface less useful
and could present a hand-drawn feature as authoritative.

## Commands

```bash
npm run outdoors:sync
npm run outdoors:validate
npm run outdoors:pmtiles
npm run outdoors:pmtiles:publish
npm run outdoors:kml:import -- /path/to/plan.kml
```

`outdoors:sync` currently builds the province-wide Wildlife Management Unit
snapshot. `sources.json` records the next layers to add without pretending
that PDF-derived or incomplete data is authoritative.

PMTiles are generated in the ignored `build/bc-outdoors-pmtiles` directory.
The committed publication catalog is written to
`output/r2/pmtiles-catalog.json`. Publishing uses immutable versioned objects
under `bc/outdoors/<version>/` and updates the short-cache catalog at:

```text
https://data.map.ahmad.sh/bc/outdoors/catalog.json
```

## Planning feature contract

The KML importer preserves folder paths and normalizes each placemark into a
planning class:

| Class | Examples from MU-7-42 |
|---|---|
| `legal-hunt-area` | Elk LEH 7-42A |
| `management-context` | MU 7-42 boundary |
| `vehicle-closure` | Klingzut Mountain closed area |
| `designated-corridor` | Muskwa-Kechika designated roads |
| `navigable-water` | Muskwa and Prophet Rivers |
| `formal-access` | Muskwa River Boat Launch |
| `access-candidate` | highway crossings and possible river access |
| `recreation-site` | shelters and recreation reserves near water |
| `travel-range` | 50 km and 50–75 km planning markers |
| `personal-note` | camps, routes and uncategorized waypoints |

Every imported feature remains `authority: user-supplied` unless it is rebuilt
from the maintained public source pipeline. Descriptions such as “formal” or
citations embedded in a KML do not silently promote a user feature to an
authoritative regulatory layer.
