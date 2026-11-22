"""Read and encode one DICOM pixel frame for the backend response."""

from __future__ import annotations

import math
from copy import copy
from pathlib import Path

import numpy as np
from pydicom import dcmread
from pydicom.dataset import Dataset
from pydicom.pixels import apply_color_lut, apply_modality_lut, pixel_array


_FRAME_METADATA_TAGS = [
    0x52009229,  # Shared Functional Groups Sequence
    0x52009230,  # Per-Frame Functional Groups Sequence
    0x00280030,  # Pixel Spacing
    0x00280004,  # Photometric Interpretation
    0x00281050,  # Window Center
    0x00281051,  # Window Width
    0x00281052,  # Rescale Intercept
    0x00281053,  # Rescale Slope
    0x00283000,  # Modality LUT Sequence
    0x00281101,  # Red Palette Color Lookup Table Descriptor
    0x00281102,  # Green Palette Color Lookup Table Descriptor
    0x00281103,  # Blue Palette Color Lookup Table Descriptor
    0x00281201,  # Red Palette Color Lookup Table Data
    0x00281202,  # Green Palette Color Lookup Table Data
    0x00281203,  # Blue Palette Color Lookup Table Data
]
_MAX_FRAME_PIXELS = 16_000_000


def _raw_values(value: object) -> list[float | None]:
    if value is None:
        return []
    if isinstance(value, str):
        raw_values = value.split("\\")
    else:
        try:
            raw_values = list(value)  # type: ignore[arg-type]
        except TypeError:
            raw_values = [value]
    numbers: list[float | None] = []
    for raw in raw_values:
        try:
            number = float(raw)
        except (TypeError, ValueError, OverflowError):
            numbers.append(None)
            continue
        numbers.append(number if math.isfinite(number) else None)
    return numbers


def _values(value: object) -> list[float]:
    return [number for number in _raw_values(value) if number is not None]


def _format_number(value: float) -> str:
    return format(value, ".15g")


def _frame_items(ds: Dataset, index: int, sequence_name: str) -> list[Dataset]:
    groups: list[Dataset] = []
    per_frame = getattr(ds, "PerFrameFunctionalGroupsSequence", None)
    shared = getattr(ds, "SharedFunctionalGroupsSequence", None)
    if per_frame and index < len(per_frame):
        groups.append(per_frame[index])
    if shared:
        groups.append(shared[0])
    items = []
    for group in groups:
        sequence = getattr(group, sequence_name, None)
        if sequence:
            items.append(sequence[0])
    return items


def _metadata_sources(ds: Dataset, index: int, sequence_name: str) -> list[Dataset]:
    return [*_frame_items(ds, index, sequence_name), ds]


def _window(ds: Dataset, index: int, pixels: np.ndarray) -> tuple[str, str]:
    for source in _metadata_sources(ds, index, "FrameVOILUTSequence"):
        centers = _raw_values(getattr(source, "WindowCenter", None))
        widths = _raw_values(getattr(source, "WindowWidth", None))
        for center, width in zip(centers, widths):
            if center is not None and width is not None and width > 0:
                return _format_number(center), _format_number(width)

    finite = pixels[np.isfinite(pixels)]
    if finite.size:
        low = float(np.min(finite))
        high = float(np.max(finite))
        return _format_number((low + high) / 2), _format_number(max(high - low, 1.0))
    return "0", "1"


def _pixel_spacing(ds: Dataset, index: int) -> str:
    for source in _metadata_sources(ds, index, "PixelMeasuresSequence"):
        spacing = _raw_values(getattr(source, "PixelSpacing", None))
        if (
            len(spacing) == 2
            and all(value is not None and value > 0 for value in spacing)
        ):
            row, column = spacing
            assert row is not None and column is not None
            return f"{_format_number(row)},{_format_number(column)}"
    return ""


def _effective_modality_metadata(ds: Dataset, index: int) -> Dataset:
    effective = copy(ds)
    for source in _metadata_sources(ds, index, "PixelValueTransformationSequence"):
        slope = _values(getattr(source, "RescaleSlope", None))
        intercept = _values(getattr(source, "RescaleIntercept", None))
        if slope and intercept:
            effective.RescaleSlope = slope[0]
            effective.RescaleIntercept = intercept[0]
            if source is not ds and "ModalityLUTSequence" in effective:
                del effective.ModalityLUTSequence
            return effective
    for name in ("RescaleSlope", "RescaleIntercept"):
        values = _values(getattr(ds, name, None))
        if values:
            setattr(effective, name, values[0])
        elif name in effective:
            delattr(effective, name)
    return effective


def _rgb_pixels(pixels: np.ndarray, metadata: Dataset) -> np.ndarray:
    photometric = metadata.PhotometricInterpretation
    if photometric == "PALETTE COLOR":
        pixels = apply_color_lut(pixels, metadata)
        descriptor = _values(metadata.RedPaletteColorLookupTableDescriptor)
        bits_stored = (
            int(descriptor[2]) if len(descriptor) >= 3 else pixels.dtype.itemsize * 8
        )
    elif photometric not in {"RGB", "YBR_FULL", "YBR_FULL_422"}:
        raise ValueError("unsupported color photometric interpretation")
    else:
        stored = _values(getattr(metadata, "BitsStored", None))
        bits_stored = int(stored[0]) if stored else pixels.dtype.itemsize * 8
    if pixels.ndim != 3 or pixels.shape[-1] != 3:
        raise ValueError("frame is not an RGB image")
    maximum = (
        float((1 << bits_stored) - 1)
        if bits_stored > 0
        else float(np.iinfo(pixels.dtype).max)
    )
    if pixels.dtype != np.uint8 or maximum != 255:
        pixels = np.clip(
            np.rint(pixels.astype(np.float64) * (255.0 / maximum)), 0, 255
        )
    return np.asarray(pixels, dtype=np.uint8, order="C")


def encode_frame(source: Path, index: int) -> tuple[bytes, dict[str, str]]:
    """Return one decoded frame as little-endian float32 plus response headers."""
    if isinstance(index, bool) or not isinstance(index, int) or index < 0:
        raise ValueError("frame index must be a non-negative integer")

    header = dcmread(
        source,
        stop_before_pixels=True,
        specific_tags=[0x00280010, 0x00280011],
    )
    try:
        rows, columns = int(header.Rows), int(header.Columns)
    except (AttributeError, TypeError, ValueError, OverflowError):
        raise ValueError("invalid frame dimensions") from None
    if rows <= 0 or columns <= 0 or rows * columns > _MAX_FRAME_PIXELS:
        raise ValueError("frame dimensions exceed supported limit")

    metadata = Dataset()
    pixels = pixel_array(
        source, index=index, ds_out=metadata, specific_tags=_FRAME_METADATA_TAGS
    )
    photometric = getattr(metadata, "PhotometricInterpretation", "")
    if photometric in {"MONOCHROME1", "MONOCHROME2"} and pixels.ndim == 2:
        modality_metadata = _effective_modality_metadata(metadata, index)
        pixels = apply_modality_lut(pixels, modality_metadata)
        body = np.asarray(pixels, dtype="<f4", order="C").tobytes(order="C")
        pixel_type = "f32"
    else:
        pixels = _rgb_pixels(pixels, metadata)
        body = pixels.tobytes(order="C")
        pixel_type = "rgb"
    window_center, window_width = _window(metadata, index, pixels)
    headers = {
        "X-Width": str(metadata.Columns),
        "X-Height": str(metadata.Rows),
        "X-Type": pixel_type,
        "X-Window-Center": window_center,
        "X-Window-Width": window_width,
        "X-Invert": "1" if photometric == "MONOCHROME1" else "0",
        "X-Pixel-Spacing": _pixel_spacing(metadata, index),
    }
    return body, headers
