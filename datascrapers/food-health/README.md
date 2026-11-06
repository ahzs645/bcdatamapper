# Food Health Scrapers

These scripts were brought over from `PGFoodHealth` so `PGMaps` can refresh its Northern Health Authority HealthSpace restaurant inspection dataset directly.

## Setup

```bash
python3 -m venv .venv-food-health
source .venv-food-health/bin/activate
pip install -r datascrapers/food-health/requirements.txt
```

## Refresh Prince George Inspection Data

```bash
npm run food-health:refresh
```

This runs the incremental scraper for Prince George and writes to `datascrapers/food-health/output/restaurants.json`. The scraper resumes from existing records and saves progress after each restaurant.

`--refresh-older-than 30` re-fetches any record last fetched more than 30 days ago. Without it the scraper skips every record it already holds and only adds new premises, so existing restaurants never gain new inspections. A re-fetch merges into the stored record: geocoding and inspections the source no longer lists are kept, and a failed fetch leaves the record untouched.

## Geocode Missing Restaurant Coordinates

```bash
npm run food-health:geocode
```

This uses OpenStreetMap Nominatim, skips restaurants that already have coordinates, and saves progress back to `datascrapers/food-health/output/restaurants.json`.

## Useful Direct Commands

```bash
python3 datascrapers/food-health/healthspace_pg_restaurants.py --list-cities
python3 datascrapers/food-health/fetch_incremental.py --city "Prince George" --output datascrapers/food-health/output/restaurants.json --delay 5 --refresh-older-than 30
python3 datascrapers/food-health/geocode_restaurants.py --file datascrapers/food-health/output/restaurants.json --delay 1.5
```

The HealthSpace scraper writes `healthspace_response.html` and `healthspace_debug.html` while debugging parser responses; those files are ignored by git.
