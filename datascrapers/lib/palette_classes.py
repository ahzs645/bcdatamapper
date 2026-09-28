"""Infer display classes from RGB pixels. This does not recover source measurements."""
import numpy as np


def classify_rgba(rgba, palette, *, max_distance=60, min_margin=20, min_alpha=250, uncertain=99):
    """Euclidean sRGB distance/margin are explicit heuristics, not probabilities.

    Transparent pixels are NoData (0); translucent and ambiguous pixels are
    uncertain. Opaque white is a class only when explicitly in the palette.
    """
    if rgba.ndim != 3 or rgba.shape[0] != 4 or len(palette) < 2:
        raise ValueError('Expected four bands and at least two palette entries')
    codes = np.array(list(palette), dtype=np.uint16)
    if 0 in codes or uncertain in codes or any(not 0 < c < 65536 for c in palette):
        raise ValueError('Palette codes must be unique uint16 values excluding NoData and uncertain')
    colors = np.array(list(palette.values()), dtype=np.float32)
    distances = np.sqrt(np.sum((rgba[:3].astype(np.float32).transpose(1, 2, 0)[:, :, None, :] - colors) ** 2, axis=3))
    nearest = distances.argmin(axis=2)
    ordered = np.sort(distances, axis=2)
    accepted = (ordered[:, :, 0] <= max_distance) & ((ordered[:, :, 1] - ordered[:, :, 0]) >= min_margin) & (rgba[3] >= min_alpha)
    result = np.where(accepted, codes[nearest], uncertain).astype('uint16')
    result[rgba[3] == 0] = 0
    return result
