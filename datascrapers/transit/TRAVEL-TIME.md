# Prince George travel-time snapshot

`build-travel-time.py` prepares the schedule and street graph consumed by
PGMaps `/dev/transit`. The deterministic gzip snapshot belongs in this repository,
under `output/prince_george_travel_time.json.gz`. PGMaps's existing data sync
copies it to `public/data/transit`; do not commit that generated copy in PGMaps.

```sh
curl -fL 'https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=22' -o /tmp/pg-gtfs.zip
python3 datascrapers/transit/build-travel-time.py /tmp/pg-gtfs.zip --date 2026-10-07
python3 datascrapers/transit/test-travel-time.py
python3 datascrapers/transit/audit-travel-time.py --strict
```

Choose a service date covered by the downloaded feed. The initial snapshot uses
Wednesday, October 7, 2026. Calendar and calendar_dates determine service; the
browser's departure time is interpreted in the feed's Pacific timezone on that
reference day. The snapshot records feed validity and SHA-256 of every input.

The exact official feed used for the committed example is retained at
`source/prince_george_gtfs_2026-10-07.zip`; the date identifies the example service
day. Its SHA-256 is recorded in snapshot metadata. Reproduce the example from
the scraper repository root with:

```sh
python3 datascrapers/transit/build-travel-time.py \
  datascrapers/transit/source/prince_george_gtfs_2026-10-07.zip \
  --date 2026-10-07 --grid-meters 50 --access-meters 350
```

## Reuse for another city

The GTFS-to-snapshot approach, connection-scan routing, live heat renderer and
spatial audit can be reused. This builder still hardcodes the PG study bounds,
metric reference latitude, CityPG source paths, bus-only filter and output name.
The audit also uses PG facility inputs and reported regression points. The client
has PG defaults, Pacific timezone labels and BC geocoding. These settings must
be extracted together before a new city is a configuration-only addition.
The detailed application contract and proposed adaptation checklist live in
PGMaps `docs/transit-pipeline.md`. Rail/ferry and frequency-based schedules need
importer extensions and matching routing tests. Do not assume they are supported.

Transit connections preserve trip identity, stop sequence, scheduled departure
and arrival, pickup/drop-off restrictions, headsign and GTFS shapes. Trips with
stops outside the study rectangle are omitted in full, never joined across a
missing intermediate stop. The connection-scan engine applies a one-minute
boarding allowance, preserves in-vehicle continuity and permits street-network
walking transfers of up to 650 metres. No real-time delays are consumed.

Walking uses existing City of PG `roads.geojson` and `walkways.geojson` in
`datascrapers/citypg/output`. Each line is simplified by 8 metres while retaining
endpoints, densified to segments no longer than 80 metres, and joined by projecting
source endpoints onto nearby segments within 12 metres. Matched edges are split
at the junction so sampling spacing cannot strand a path beside a road. Interior
line crossings alone do not create junctions. Walking is bidirectional at 4.5 km/h. This is a street-access
estimate, not an audited pedestrian network: sidewalks, crossing permissions,
private roads, accessibility and grade restrictions are not verified. Connectors
to the nearest network vertex extend up to 180 metres for transit stops and
350 metres for markers and heat samples, controlled by `--access-meters` and
recorded as `meta.markerAccessMeters` and `meta.gridAccessMeters`. Estimated
access walking is included in every time. The shared marker/heat limit allows
larger blocks and campuses without contradictory blank areas. These are straight-line
estimates and can be inaccurate near barriers. Longer journeys follow network
connectivity, including bridge detours, instead of crossing rivers by distance.

For marker, stop and heat-cell access, the largest road-connected component takes
priority over smaller disconnected road and walkway assets within the same access radius. For
example, the isolated path at 2901 Griffiths Avenue must not trap a building's
starting point when a mapped street is nearby. `streetAccessNodes` records those
preferred vertices, including walkways connected to the main city network. If no preferred
vertex is in range, the nearest standalone path remains available; its component
is not artificially joined to a street. `meta.isolatedWalkVertices` records the
number of vertices without a mapped road connection. This access preference
does not verify pedestrian crossings or physical access through a property.

## Repeatable spatial audit

`audit-travel-time.py --strict` sweeps the full study rectangle at 50-metre
spacing (270,810 locations), labels every connected component, checks all three
reported problem origins, and checks 135 civic/park facility locations. It saves
`output/travel-time-audit.json`, with missing access, isolated components and
residual facility gaps; water/forest outside the access limit is reported rather
than treated as a routing defect. Pass `--baseline /path/to/old-snapshot.json.gz`
to compare coverage before and after a rebuild. Strict mode fails for marker/heat
disagreement, inaccessible reported origins, or isolated preferred components.
The baseline used by the saved report is retained as
`source/prince_george_travel_time_pre_access_sweep.json.gz`. Pass that archive
with `--baseline` to reproduce the saved before/after coverage counts; omitting
it audits current coverage without retaining that historical comparison.
The application `access-sweep.test.ts` independently compares live browser
sampling and marker snapping with every cell in the Python-generated snapshot.
The audit does not establish legal pedestrian access or fill missing park trails.

Heat-grid values are travel time to grid-cell centres. `--grid-meters` controls
sample spacing (default 50 metres), also recorded as `meta.gridCellMeters`.
The renderer interpolates minutes into a 2× image before applying the colour
ramp, fading missing access at edges without filling disconnected gaps. Finer
sampling improves display detail, not the accuracy of the street inputs.
Transparent cells have no nearby network access or connected route. Contours interpolate this grid and
are estimates; they are not surveyed boundaries. GTFS and source geometries are
not embedded into the application's JavaScript bundle.

Sources: [BC Transit open data and terms](https://www.bctransit.com/open-data/),
[City of Prince George GIS](https://www.princegeorge.ca/city-hall/maps-access-information).
The interactions and green-to-red colour ramp follow
[Camille Roux's map](https://tram.camilleroux.com/bruxelles/). The renderer and
routing code are implemented natively in PGMaps; no uploaded analytics scripts,
French geocoder or Brussels data are shipped.
