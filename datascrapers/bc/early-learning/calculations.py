"""Reproduce aggregate arithmetic without inferring suppressed child counts."""
from collections import Counter

SCALES = ('overall', 'physical', 'social', 'emotional', 'language', 'communication')
TOLERANCE_PP = 0.050000001  # Published percentages have one decimal place.


def audit_family(family):
    summary = Counter()
    for region in family['regions']:
        region.pop('multipleCountChecks', None)
        observations = {(o['wave'], o['measure']): o for o in region['observations']}
        for wave in sorted({w for w, _ in observations}):
            denominators = {}
            for scale in SCALES:
                categories = ('vulnerable', 'in_flux' if scale == 'overall' else 'at_risk', 'on_track')
                keys = [f'count_{scale}_{category}' for category in categories]
                counts = [observations.get((wave, key), {}).get('value') for key in keys]
                if all(isinstance(v, (int, float)) and v >= 0 for v in counts) and sum(counts) > 0:
                    denominators[scale] = (sum(counts), keys)
            for (w, key), o in observations.items():
                if w != wave or not key.startswith('pct_') or o['value'] is None:
                    continue
                # Demographic denominators and the Province's mislabeled 0-scale
                # percentage are outside this audit. Never infer their meaning.
                scale = key.split('_')[1]
                if scale not in SCALES and key not in {f'pct_multiple_{i}' for i in range(1, 6)}:
                    continue
                denominator = denominators.get('overall' if scale == 'multiple' else scale)
                numerator_key = key.replace('pct_', 'count_', 1)
                numerator = observations.get((wave, numerator_key), {}).get('value')
                if denominator is None or numerator is None:
                    o['calculation'] = {'status': 'unavailable', 'reason': 'Complete unsuppressed outcome counts are unavailable in this source release and wave.'}
                    summary['unavailable'] += 1
                    continue
                total, inputs = denominator
                value = 100 * numerator / total
                difference = value - o['value']
                status = 'matches' if abs(difference) <= TOLERANCE_PP else 'differs'
                o['calculation'] = {'status': status, 'value': value, 'numerator': numerator, 'denominator': total,
                                    'numeratorMeasure': numerator_key, 'denominatorMeasures': inputs,
                                    'differencePp': difference, 'method': '100 × published count / sum of the three mutually exclusive outcome counts'}
                summary[status] += 1
            # Exactly 1, 2, ... 5 vulnerable scales partition overall vulnerability.
            # Do not sum the five individual scale counts: children overlap.
            multiple = [observations.get((wave, f'count_multiple_{i}'), {}).get('value') for i in range(1, 6)]
            overall = observations.get((wave, 'count_overall_vulnerable'), {}).get('value')
            if overall is not None and all(v is not None for v in multiple):
                check = {'wave': wave, 'sum': sum(multiple), 'publishedOverallCount': overall,
                         'status': 'matches' if sum(multiple) == overall else 'differs'}
                region.setdefault('multipleCountChecks', []).append(check)
                summary['multipleCounts_' + check['status']] += 1
    return dict(summary)
