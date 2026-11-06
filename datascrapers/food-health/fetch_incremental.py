#!/usr/bin/env python3
"""
Incremental fetcher for Prince George restaurant data.
Saves progress after each restaurant so it can be resumed if interrupted.

A restaurant already fetched is skipped, so a plain run only picks up new
premises. Pass --refresh-older-than DAYS to re-fetch records older than that,
which is what brings in new inspections for existing premises.
"""

import json
import os
import time
from datetime import datetime, timedelta
from healthspace_pg_restaurants import HealthSpaceAPI


def needs_fetch(existing, refresh_older_than_days=None, now=None):
    """Whether a restaurant's stored record should be fetched on this run."""
    if not existing or not existing.get('details_fetched_at') or existing.get('fetch_error'):
        return True
    if refresh_older_than_days is None:
        return False
    try:
        fetched_at = datetime.fromisoformat(existing['details_fetched_at'])
    except ValueError:
        return True
    return (now or datetime.now()) - fetched_at > timedelta(days=refresh_older_than_days)


def inspection_key(inspection):
    return (inspection.get('date') or inspection.get('inspection_date'), inspection.get('type'))


def merge_refreshed(existing, fetched):
    """
    Lay a re-fetched record over the stored one.

    The stored record holds what the scraper doesn't produce (geocoding,
    overrides) and inspections the source may have since dropped, so nothing is
    replaced with an empty value and no inspection is lost. A fetched inspection
    wins over a stored one with the same date and type.
    """
    merged = dict(existing)
    merged.update({key: value for key, value in fetched.items() if value not in (None, '', [])})
    fetched_inspections = fetched.get('inspections') or []
    seen = {inspection_key(inspection) for inspection in fetched_inspections}
    merged['inspections'] = fetched_inspections + [
        inspection for inspection in existing.get('inspections') or [] if inspection_key(inspection) not in seen
    ]
    merged.pop('fetch_error', None)
    return merged


def fetch_incremental(city="Prince George", output_file=None, max_inspections=None, delay=5,
                      refresh_older_than_days=None):
    """
    Fetch restaurant data incrementally, saving after each restaurant.

    Args:
        city: City to fetch data for
        output_file: Output JSON file (default: {city}_restaurants_full.json)
        max_inspections: Max inspections per restaurant (None for all)
        delay: Seconds to wait between restaurants (default 5, increase if rate limited)
        refresh_older_than_days: Re-fetch records older than this; None skips every fetched record
    """
    if output_file is None:
        safe_city = city.lower().replace(' ', '_').replace('.', '')
        output_file = f'{safe_city}_restaurants_full.json'

    api = HealthSpaceAPI(city=city)

    # Load existing data if resuming - use dict to preserve ALL data
    all_data = {}  # name -> restaurant dict (preserves ALL existing data)
    if os.path.exists(output_file):
        with open(output_file, 'r') as f:
            data = json.load(f)
            for r in data:
                all_data[r.get('name')] = r
        # Count successfully fetched (for display)
        success_count = sum(1 for r in all_data.values()
                          if r.get('details_fetched_at') and not r.get('fetch_error'))
        print(f"Loaded {len(all_data)} restaurants from {output_file}")
        print(f"  ({success_count} successfully fetched, {len(all_data) - success_count} need retry)")

    # Get full restaurant list
    print(f"\nFetching restaurant list for {city}...")
    all_restaurants = api.get_all_restaurants()

    if not all_restaurants:
        print("Failed to fetch restaurant list")
        return None

    # Count how many we need to fetch
    already_fetched = sum(1 for r in all_restaurants
                         if not needs_fetch(all_data.get(r.get('name')), refresh_older_than_days))

    print(f"Found {len(all_restaurants)} restaurants total")
    print(f"Already fetched: {already_fetched}")
    print(f"Remaining: {len(all_restaurants) - already_fetched}")
    print("=" * 60)

    # Process each restaurant
    fetched_count = 0
    skipped_count = 0

    for i, restaurant in enumerate(all_restaurants):
        name = restaurant.get('name', 'Unknown')

        # Check if already successfully fetched
        existing = all_data.get(name)
        if not needs_fetch(existing, refresh_older_than_days):
            skipped_count += 1
            print(f"[{i+1}/{len(all_restaurants)}] SKIP: {name} (already fetched)")
            continue

        print(f"\n[{i+1}/{len(all_restaurants)}] Fetching: {name}")

        try:
            # Fetch full details
            api.get_restaurant_full_details(
                restaurant,
                fetch_inspections=True,
                max_inspections=max_inspections
            )
            restaurant['city'] = city
            all_data[name] = merge_refreshed(existing, restaurant) if existing else restaurant
            fetched_count += 1

            # Save ALL data after each successful fetch (never lose data!)
            save_progress(list(all_data.values()), output_file)
            print(f"  Saved progress ({len(all_data)} restaurants total)")

            # Be respectful - use longer delay to avoid rate limiting
            print(f"  Waiting {delay}s...")
            time.sleep(delay)

        except Exception as e:
            print(f"  ERROR: {e}")
            # Still add basic info
            # A stored record stays as it is and is retried on the next refresh.
            if not existing or not existing.get('details_fetched_at'):
                restaurant['city'] = city
                restaurant['fetch_error'] = str(e)
                all_data[name] = restaurant
            save_progress(list(all_data.values()), output_file)

    print("\n" + "=" * 60)
    print("COMPLETE!")
    print(f"Total restaurants: {len(all_data)}")
    print(f"Newly fetched: {fetched_count}")
    print(f"Skipped (already had): {skipped_count}")
    print(f"Output file: {output_file}")
    print("=" * 60)

    return list(all_data.values())


def save_progress(data, filename):
    """Save current progress to file"""
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    import sys

    city = "Prince George"
    output_file = "public/data/restaurants.json"
    delay = 5  # seconds between restaurants
    refresh_older_than_days = None

    # Parse args
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == '--city' and i + 1 < len(args):
            city = args[i + 1]
            i += 2
        elif args[i] == '--output' and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif args[i] == '--delay' and i + 1 < len(args):
            delay = int(args[i + 1])
            i += 2
        elif args[i] == '--refresh-older-than' and i + 1 < len(args):
            refresh_older_than_days = int(args[i + 1])
            i += 2
        elif args[i] in ['--help', '-h']:
            print("Usage: python fetch_incremental.py [--city NAME] [--output FILE] [--delay SECONDS] "
                  "[--refresh-older-than DAYS]")
            print("  --city NAME    City to fetch (default: Prince George)")
            print("  --output FILE  Output JSON file (default: public/data/restaurants.json)")
            print("  --delay SECS   Delay between restaurants (default: 5)")
            print("  --refresh-older-than DAYS  Re-fetch records older than DAYS (default: skip fetched records)")
            sys.exit(0)
        else:
            # Assume first positional arg is city for backwards compat
            city = args[i]
            i += 1

    print("=" * 60)
    print(f"Incremental Restaurant Data Fetcher")
    print(f"City: {city}")
    print(f"Output file: {output_file}")
    print(f"Delay: {delay}s between restaurants")
    if refresh_older_than_days is not None:
        print(f"Refreshing records older than {refresh_older_than_days} days")
    print("=" * 60)
    print("\nThis script saves progress after each restaurant.")
    print("If interrupted, just run again to resume.\n")

    fetch_incremental(city=city, output_file=output_file, delay=delay, refresh_older_than_days=refresh_older_than_days)
