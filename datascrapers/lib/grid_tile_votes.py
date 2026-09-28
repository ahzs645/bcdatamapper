"""Accumulate cell-interior votes across XYZ tile seams on a fixed geographic grid."""

import numpy as np

CODES = np.array([10, 20, 30, 40, 99], dtype="uint16")


def axis_cells(z, tile, axis, origin, step, length, size=256, inset=0.2):
    p = tile * size + np.arange(size) + 0.5
    if axis == "x":
        coordinate = p / (2**z * size) * 360 - 180
        cell = (coordinate - origin) / step
    else:
        coordinate = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * p / (2**z * size)))))
        cell = (origin - coordinate) / step
    index = np.floor(cell).astype("int32")
    fraction = cell - index
    keep = (
        (index >= 0) & (index < length) & (fraction >= inset) & (fraction <= 1 - inset)
    )
    return np.where(keep)[0], index[keep]


def accumulate(counts, labels, rows, cols):
    """labels contains only interior samples; transparent samples contribute no class votes."""
    if not len(rows) or not len(cols):
        return
    r0, r1, c0, c1 = (
        int(rows.min()),
        int(rows.max()) + 1,
        int(cols.min()),
        int(cols.max()) + 1,
    )
    width = c1 - c0
    bins = ((rows[:, None] - r0) * width + (cols[None, :] - c0)).ravel()
    for k, code in enumerate(CODES):
        values = np.bincount(
            bins, weights=(labels == code).ravel(), minlength=(r1 - r0) * width
        )
        counts[k, r0:r1, c0:c1] += values.reshape(r1 - r0, width).astype("uint16")


def resolve(counts, expected, minimum=4, threshold=0.8):
    valid = counts[:4].sum(axis=0, dtype="uint32")
    observed = valid + counts[4]
    winner = counts[:4].argmax(axis=0)
    top = counts[:4].max(axis=0)
    accepted = (
        (valid >= minimum)
        & (valid >= expected * threshold)
        & (top >= valid * threshold)
    )
    result = np.where(observed == 0, 0, 99).astype("uint16")
    result[accepted] = CODES[winner[accepted]]
    return result
