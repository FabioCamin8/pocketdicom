"""Build a metadata-only catalog of local DICOM instances."""

from __future__ import annotations

from dataclasses import dataclass, field
import itertools
import math
import os
from pathlib import Path
import re
from statistics import median
from typing import Iterable, Any
from uuid import uuid4
import warnings

import pydicom
from pydicom.datadict import dictionary_VR, tag_for_keyword
from pydicom.dataset import Dataset
from pydicom.filereader import read_partial
from pydicom.tag import Tag


MAX_PATHS = 2_000
MAX_TOTAL_FRAMES = 50_000
MAX_FRAMES_PER_INSTANCE = 10_000
MAX_TEXT_BYTES = 4_096

# Optional local opt-in for known-mislabelled legacy text. Data must still be
# explicitly decoded from an allowlisted single-byte or legacy CJK codec; no
# codec is ever inferred from the bytes. Unsupported values are ignored and
# fall back to pydicom. Only absent/empty/ISO_IR 6 declarations are eligible;
# escapes, other or unknown declarations, and non-text VRs stay with pydicom.
LEGACY_CHARSET_ENV = "POCKET_DICOM_LEGACY_CHARSET"
_LEGACY_CHARSETS = {
    "cp1251": "cp1251",
    "windows-1251": "cp1251",
    "cp1252": "cp1252",
    "windows-1252": "cp1252",
    "cp1253": "cp1253",
    "windows-1253": "cp1253",
    "cp1255": "cp1255",
    "windows-1255": "cp1255",
    "gbk": "gbk",
    "gb18030": "gb18030",
    "big5": "big5",
    "euc_kr": "euc_kr",
    "euc-kr": "euc_kr",
    "shift_jis": "shift_jis",
    "shift-jis": "shift_jis",
    "sjis": "shift_jis",
}
# PS3.5 text VRs whose meaning depends on (0008,0005) Specific Character Set.
_LEGACY_TEXT_VRS = frozenset({"LO", "LT", "PN", "SH", "ST", "UC", "UT"})

_TAG_NAMES = (
    "PatientName", "PatientID", "PatientBirthDate", "PatientSex", "PatientAge",
    "StudyInstanceUID", "SeriesInstanceUID", "StudyDate", "StudyTime", "StudyDescription",
    "AccessionNumber", "StudyID",
    "SeriesDate", "SeriesTime", "SeriesDescription", "SeriesNumber", "ProtocolName",
    "BodyPartExamined", "Modality", "Manufacturer", "ManufacturerModelName",
    "SOPClassUID", "SOPInstanceUID", "InstanceNumber", "Rows", "Columns",
    "SamplesPerPixel", "PhotometricInterpretation", "NumberOfFrames", "ImageType",
    "ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing", "SliceThickness",
    "SpacingBetweenSlices", "FrameOfReferenceUID", "AcquisitionNumber", "EchoNumbers",
    "EchoTime", "TriggerTime", "TemporalPositionIdentifier", "FrameTime",
    "FrameTimeVector", "DocumentTitle", "CompletionFlag", "VerificationFlag",
    "ContentDate", "ContentTime",
)
_TAGS = {name: tag_for_keyword(name) for name in _TAG_NAMES}
_BASE_SPECIFIC_TAGS = tuple(tag for tag in _TAGS.values() if tag is not None)
_FUNCTIONAL_GROUP_TAGS = tuple(
    tag_for_keyword(name)
    for name in ("SharedFunctionalGroupsSequence", "PerFrameFunctionalGroupsSequence")
)
_PIXEL_DATA_TAGS = {
    Tag(0x7FE00010),  # PixelData
    Tag(0x7FE00008),  # FloatPixelData
    Tag(0x7FE00009),  # DoubleFloatPixelData
}
_TEMPORAL_TAGS = (
    "TemporalPositionIdentifier", "TemporalPositionIndex", "TriggerTime",
    "AcquisitionNumber", "EchoNumbers", "EchoTime",
)


@dataclass(frozen=True)
class Frame:
    path: Path
    index: int
    tags: dict[str, str]


@dataclass
class _CatalogFrame:
    public: Frame
    record: dict[str, Any]
    rows: int | None
    columns: int | None
    pixel_spacing: tuple[float, float] | None
    orientation: tuple[float, ...] | None
    position: tuple[float, float, float] | None
    slice_thickness: float | None
    frame_of_reference: str | None
    photometric: str | None
    temporal: dict[str, str | None]
    scout: bool
    multiframe: bool


@dataclass
class _Series:
    uid: str
    id: str = field(default_factory=lambda: uuid4().hex)
    metadata: dict[str, str] = field(default_factory=dict)
    frames: list[_CatalogFrame] = field(default_factory=list)


@dataclass
class _Study:
    uid: str
    id: str = field(default_factory=lambda: uuid4().hex)
    metadata: dict[str, str] = field(default_factory=dict)
    series: dict[str, _Series] = field(default_factory=dict)


def build_catalog(paths: Iterable[Path]) -> tuple[list[dict[str, Any]], dict[str, Frame], int]:
    """Read bounded DICOM metadata and group it into studies and series.

    Pixel data is never decoded or returned. Invalid inputs are counted and skipped.
    """
    studies_by_uid: dict[str, _Study] = {}
    frames_by_id: dict[str, Frame] = {}
    seen_instances: set[str] = set()
    skipped = 0
    total_frames = 0
    iterator = iter(paths)
    try:
        path_count = len(paths)  # type: ignore[arg-type]
    except (TypeError, AttributeError):
        path_count = None

    for path in itertools.islice(iterator, MAX_PATHS):
        try:
            dataset = _read_dataset(path)
            if dataset is None:
                skipped += 1
                continue

            study_uid = _required_uid(dataset, "StudyInstanceUID")
            series_uid = _required_uid(dataset, "SeriesInstanceUID")
            instance_uid = _required_uid(dataset, "SOPInstanceUID")
            class_uid = _required_uid(dataset, "SOPClassUID")
            frame_uid = _safe_value(dataset, "FrameOfReferenceUID")
            if (
                not study_uid
                or not series_uid
                or not instance_uid
                or not class_uid
                or (frame_uid is not None and not _valid_uid(str(frame_uid)))
                or instance_uid in seen_instances
            ):
                skipped += 1
                continue

            frame_count = _frame_count(dataset)
            if frame_count is None or frame_count > MAX_FRAMES_PER_INSTANCE:
                skipped += 1
                continue
            if total_frames + frame_count > MAX_TOTAL_FRAMES:
                skipped += 1
                continue

            shared, per_frame = _functional_groups(dataset, frame_count)
            if per_frame is None:
                skipped += 1
                continue

            metadata = _values(dataset, _TAG_NAMES)
            candidates = _make_frames(path, dataset, metadata, frame_count, shared, per_frame)
            study = studies_by_uid.get(study_uid)
            if study is not None and _different_patient(study.metadata, metadata):
                skipped += 1
                continue
            if study is None:
                study = _Study(study_uid, metadata=metadata)
                studies_by_uid[study_uid] = study
            series = study.series.get(series_uid)
            if series is None:
                series = _Series(series_uid, metadata=metadata)
                study.series[series_uid] = series

            series.frames.extend(candidates)
            seen_instances.add(instance_uid)
            total_frames += frame_count
        except Exception:
            skipped += 1

    if path_count is None:
        try:
            next(iterator)
        except StopIteration:
            pass
        else:
            skipped += 1
    elif path_count > MAX_PATHS:
        skipped += path_count - MAX_PATHS

    catalog: list[dict[str, Any]] = []
    for study in studies_by_uid.values():
        study_item, series_items = _study_item(study)
        study_item["series"] = series_items
        catalog.append(study_item)
        for series_item, series in zip(series_items, study.series.values()):
            frames, volume, reason, orientation, spacing_z = _series_geometry(series.frames)
            series_item["frames"] = [frame.record for frame in frames]
            series_item["volume"] = volume
            if reason:
                series_item["volumeReason"] = reason
            if orientation is not None:
                series_item["orientation"] = list(orientation)
            if volume and frames[0].frame_of_reference:
                series_item["frameOfReference"] = frames[0].frame_of_reference
            if spacing_z is not None and volume:
                series_item["spacingZ"] = spacing_z
            for frame in frames:
                frames_by_id[frame.record["id"]] = frame.public

    return catalog, frames_by_id, skipped


def _read_dataset(path: Path) -> Dataset | None:
    if path.name.casefold() == "dicomdir" or not path.is_file():
        return None
    # Read only catalog fields first. Enhanced sequences are loaded after the frame
    # limit check; the callback stops at the pixel element header.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        dataset, pixel_header = _read_partial(path, _BASE_SPECIFIC_TAGS)
        if _unusable_dataset(path, dataset, pixel_header):
            return None
        frame_count = _frame_count(dataset)
        if frame_count is None or frame_count > MAX_FRAMES_PER_INSTANCE:
            return None
        if frame_count == 1 and _has_direct_geometry(dataset):
            return dataset
        dataset, pixel_header = _read_partial(path, _BASE_SPECIFIC_TAGS + _FUNCTIONAL_GROUP_TAGS)
        if _unusable_dataset(path, dataset, pixel_header):
            return None
        return dataset


def _read_partial(path: Path, tags: tuple[Any, ...]) -> tuple[Dataset, tuple[int, int] | None]:
    pixel_header: tuple[int, int] | None = None
    with path.open("rb") as stream:
        def stop_at_pixel_data(tag: Any, _vr: str | None, length: int) -> bool:
            nonlocal pixel_header
            if tag in _PIXEL_DATA_TAGS:
                pixel_header = (stream.tell(), length)
                return True
            return False

        dataset = read_partial(
            stream,
            stop_when=stop_at_pixel_data,
            specific_tags=list(tags),
            defer_size=MAX_TEXT_BYTES,
        )
    return dataset, pixel_header


def _unusable_dataset(
    path: Path, dataset: Dataset, pixel_header: tuple[int, int] | None,
) -> bool:
    has_rows = "Rows" in dataset
    has_columns = "Columns" in dataset
    looks_like_image = has_rows or has_columns or "SamplesPerPixel" in dataset or pixel_header is not None
    if not looks_like_image:
        return True
    if not has_rows or not has_columns or pixel_header is None:
        return True
    rows = _integer(_format_value(_safe_value(dataset, "Rows")))
    columns = _integer(_format_value(_safe_value(dataset, "Columns")))
    if rows is None or columns is None or rows <= 0 or columns <= 0:
        return True
    value_offset, value_length = pixel_header
    if value_length == 0:
        return True
    if value_length != 0xFFFFFFFF:
        try:
            return value_offset + value_length > path.stat().st_size
        except OSError:
            return True
    return False


def _functional_groups(
    dataset: Dataset, frame_count: int,
) -> tuple[Dataset | None, list[Dataset] | None]:
    shared_sequence = dataset.get("SharedFunctionalGroupsSequence")
    per_sequence = dataset.get("PerFrameFunctionalGroupsSequence")
    if shared_sequence is None and per_sequence is None:
        return None, [Dataset() for _ in range(frame_count)]
    if per_sequence is None:
        return shared_sequence[0] if shared_sequence else None, [Dataset() for _ in range(frame_count)]
    if len(per_sequence) != frame_count:
        return None, None
    return shared_sequence[0] if shared_sequence else None, list(per_sequence)


def _make_frames(
    path: Path,
    dataset: Dataset,
    metadata: dict[str, str],
    frame_count: int,
    shared: Dataset | None,
    per_frame: list[Dataset],
) -> list[_CatalogFrame]:
    output = []
    multiframe = frame_count > 1
    instance_number = _integer(metadata.get("InstanceNumber"))
    for index in range(frame_count):
        group = per_frame[index]
        values = dict(metadata)
        for name in (
            "ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing",
            "SliceThickness", "SpacingBetweenSlices", "TemporalPositionIndex",
        ):
            value = _functional_value(group, shared, name)
            if value is not None:
                values[name] = _format_value(value)
        position = _numbers(values.get("ImagePositionPatient"), 3)
        orientation = _numbers(values.get("ImageOrientationPatient"), 6)
        pixel_spacing = _numbers(values.get("PixelSpacing"), 2)
        if multiframe and _functional_value(group, shared, "ImagePositionPatient") is None:
            position = None
        if pixel_spacing is not None and min(pixel_spacing) <= 0:
            pixel_spacing = None
        slice_thickness = _number(values.get("SliceThickness"))
        if slice_thickness is not None and slice_thickness <= 0:
            slice_thickness = None
        rows = _integer(values.get("Rows"))
        columns = _integer(values.get("Columns"))
        temporal = {
            name: values.get(name)
            for name in _TEMPORAL_TAGS
        }
        temporal_index = _functional_value(group, shared, "TemporalPositionIndex")
        if temporal_index is not None:
            temporal["TemporalPositionIndex"] = _format_value(temporal_index)
        image_type = values.get("ImageType", "").upper()
        description = values.get("SeriesDescription", "").upper()
        scout = any(token in image_type for token in ("LOCALIZER", "SCOUT")) or any(
            token in description for token in ("LOCALIZER", "SCOUT")
        )
        frame_id = uuid4().hex
        instance = instance_number if instance_number is not None else index + 1
        label = f"Instance {instance}" if frame_count == 1 else f"Frame {index + 1}"
        record: dict[str, Any] = {
            "id": frame_id,
            "label": label,
            "instance": instance,
        }
        if position is not None:
            record["position"] = list(position)
        if orientation is not None:
            record["orientation"] = list(orientation)
        if pixel_spacing is not None:
            record["pixelSpacing"] = list(pixel_spacing)
        public = Frame(path=path, index=index, tags=values)
        output.append(
            _CatalogFrame(
                public=public,
                record=record,
                rows=rows,
                columns=columns,
                pixel_spacing=pixel_spacing,
                orientation=orientation,
                position=position,
                slice_thickness=slice_thickness,
                frame_of_reference=values.get("FrameOfReferenceUID"),
                photometric=values.get("PhotometricInterpretation"),
                temporal=temporal,
                scout=scout,
                multiframe=multiframe,
            )
        )
    return output


def _study_item(study: _Study) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    metadata = study.metadata
    description = metadata.get("StudyDescription")
    date = metadata.get("StudyDate", "")
    patient = metadata.get("PatientName") or metadata.get("PatientID") or "Unknown patient"
    label = description or (f"Study {date}" if date else "Study")
    study_details = _details(
        label,
        metadata,
        ("StudyDescription", "StudyID", "AccessionNumber", "PatientID", "PatientSex", "PatientAge"),
    )
    series_items = []
    for series in study.series.values():
        values = series.metadata
        modality = values.get("Modality", "")
        series_label = values.get("SeriesDescription") or values.get("ProtocolName")
        series_label = series_label or (f"{modality} series" if modality else "Series")
        series_items.append(
            {
                "id": series.id,
                "label": series_label,
                "modality": modality,
                "details": _details(
                    series_label,
                    values,
                    (
                        "SeriesDescription", "SeriesNumber", "ProtocolName", "BodyPartExamined",
                        "Manufacturer", "ManufacturerModelName",
                    ),
                ),
            }
        )
    return (
        {
            "id": study.id,
            "label": label,
            "date": date,
            "patient": patient,
            "details": study_details,
        },
        series_items,
    )


def _series_geometry(
    frames: list[_CatalogFrame],
) -> tuple[list[_CatalogFrame], bool, str | None, tuple[float, ...] | None, float | None]:
    orientations = [frame.orientation for frame in frames]
    common_orientation = orientations[0] if orientations and orientations[0] else None
    if common_orientation and any(
        orientation is None or not _close_vectors(common_orientation, orientation, 1e-4)
        for orientation in orientations
    ):
        common_orientation = None
    if common_orientation and _valid_orientation(common_orientation) and all(
        frame.position is not None for frame in frames
    ):
        normal_for_sort = _normal(common_orientation)
        frames = sorted(
            frames,
            key=lambda frame: (
                _dot(frame.position or (), normal_for_sort),
                _integer(frame.public.tags.get("InstanceNumber")) or 0,
                frame.public.index,
            ),
        )
    else:
        frames = sorted(
            frames,
            key=lambda frame: (
                _integer(frame.public.tags.get("InstanceNumber")) or 0,
                frame.public.index,
            ),
        )
    reason: str | None = None
    if len(frames) < 2:
        reason = "single image"
    elif any(frame.scout for frame in frames):
        reason = "localizer/scout series"
    elif any(frame.rows is None or frame.columns is None for frame in frames) or len(
        {(frame.rows, frame.columns) for frame in frames}
    ) != 1:
        reason = "missing or mixed image dimensions"
    elif any(frame.photometric not in ("MONOCHROME1", "MONOCHROME2") for frame in frames):
        reason = "color or unsupported photometric interpretation"
    elif any(frame.pixel_spacing is None for frame in frames) or not _same_vectors(
        [frame.pixel_spacing for frame in frames], 1e-4
    ):
        reason = "missing or mixed in-plane pixel spacing"
    elif _mixed_optional_spacing([frame.slice_thickness for frame in frames]):
        reason = "mixed slice thickness"
    elif any(frame.orientation is None for frame in frames):
        reason = "missing image orientation"
    elif common_orientation is None:
        reason = "mixed image orientation or rotation"
    elif not _valid_orientation(common_orientation):
        reason = "invalid image orientation"
    elif _mixed_frame_of_reference(frames):
        reason = "mixed frame of reference"
    elif _mixed_temporal_positions(frames):
        reason = "mixed temporal positions or acquisitions"
    elif any(frame.position is None for frame in frames):
        reason = _multiframe_position_reason(frames)

    normal = _normal(common_orientation) if common_orientation and _valid_orientation(common_orientation) else None
    positions = [frame.position for frame in frames]
    projections = [sum(a * b for a, b in zip(position, normal)) for position in positions] if normal and all(
        position is not None for position in positions
    ) else []
    if reason is None and len(projections) != len(frames):
        reason = _multiframe_position_reason(frames)
    if reason is None and len(projections) >= 2:
        distances = [right - left for left, right in zip(projections, projections[1:])]
        if any(distance <= 1e-3 for distance in distances):
            reason = "duplicate slice positions"
        else:
            declared_spacings = [
                abs(value)
                for frame in frames
                if (value := _number(frame.public.tags.get("SpacingBetweenSlices"))) is not None
            ]
            expected = median(declared_spacings) if declared_spacings else median(distances)
            tolerance = max(0.01, expected * 0.01)
            if declared_spacings and (
                len(declared_spacings) != len(frames)
                or max(declared_spacings) - min(declared_spacings) > tolerance
            ):
                reason = "mixed slice spacing metadata"
            elif any(abs(distance - expected) > tolerance for distance in distances):
                reason = "irregular slice spacing or missing slices"
            elif _in_plane_drift(frames, normal):
                reason = "in-plane position drift"

    if reason:
        return frames, False, reason, common_orientation, None
    spacing_z = median([right - left for left, right in zip(projections, projections[1:])])
    return frames, True, None, common_orientation, spacing_z


def _functional_value(group: Dataset, shared: Dataset | None, keyword: str) -> Any:
    sequence_name = {
        "ImagePositionPatient": "PlanePositionSequence",
        "ImageOrientationPatient": "PlaneOrientationSequence",
        "PixelSpacing": "PixelMeasuresSequence",
        "SliceThickness": "PixelMeasuresSequence",
        "SpacingBetweenSlices": "PixelMeasuresSequence",
        "TemporalPositionIndex": "FrameContentSequence",
    }.get(keyword)
    if sequence_name is None:
        return None
    for source in (group, shared):
        if source is None:
            continue
        sequence = source.get(sequence_name)
        if sequence:
            value = sequence[0].get(keyword)
            if value is not None:
                return value
    return None


def _values(dataset: Dataset, names: Iterable[str]) -> dict[str, str]:
    output = {}
    for name in names:
        value = _safe_value(dataset, name)
        if value is not None:
            output[name] = _format_value(value)
    return output


def _safe_value(dataset: Dataset, keyword: str) -> Any:
    tag = _TAGS.get(keyword) or tag_for_keyword(keyword)
    if tag is None:
        return None
    raw = dataset.get_item(tag, keep_deferred=True)
    if raw is None:
        return None
    if getattr(raw, "is_raw", False) and getattr(raw, "length", 0) > MAX_TEXT_BYTES:
        return None
    legacy = _legacy_text_value(dataset, raw)
    if legacy is not None:
        return legacy
    return dataset.get(keyword)


def _legacy_text_value(dataset: Dataset, raw: Any) -> str | None:
    """Decode one raw text value with the explicitly configured legacy codec.

    Only applies to text VRs, raw bytes containing non-ASCII data, and a
    default/absent/ISO_IR 6 declaration. Escaped ISO 2022 values and any other
    declared charset are left entirely to pydicom.
    """
    charset = _configured_charset()
    if charset is None:
        return None
    vr = getattr(raw, "VR", None)
    if vr is None:
        tag = getattr(raw, "tag", None)
        vr = dictionary_VR(tag) if tag is not None else None
    if vr not in _LEGACY_TEXT_VRS:
        return None
    value = getattr(raw, "value", None)
    if not isinstance(value, bytes) or not value:
        return None
    if b"\x1b" in value or not any(byte >= 0x80 for byte in value):
        return None
    if not _default_charset_declaration(dataset):
        return None
    try:
        return value.decode(charset, errors="strict").rstrip("\0 ")
    except (UnicodeDecodeError, LookupError):
        return None


def _configured_charset() -> str | None:
    value = os.environ.get(LEGACY_CHARSET_ENV, "").strip().casefold()
    return _LEGACY_CHARSETS.get(value)


def _default_charset_declaration(dataset: Dataset) -> bool:
    declaration = _raw_charset_declaration(dataset)
    if declaration is None:
        return True
    tokens = [token.strip("\0 ").upper() for token in declaration.split("\\")]
    return all(token in ("", "ISO_IR 6") for token in tokens)


def _raw_charset_declaration(dataset: Dataset) -> str | None:
    raw = dataset.get_item(Tag(0x00080005), keep_deferred=True)
    value = getattr(raw, "value", None)
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("ascii")
        except UnicodeDecodeError:
            return "\0invalid"
    if isinstance(value, (list, tuple)) or value.__class__.__name__ == "MultiValue":
        return "\\".join(str(item) for item in value)
    return str(value)


def _format_value(value: Any) -> str:
    if isinstance(value, (list, tuple)) or value.__class__.__name__ == "MultiValue":
        return "\\".join(_format_value(item) for item in value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")[:MAX_TEXT_BYTES]
    return str(value)[:MAX_TEXT_BYTES]


def _numbers(value: Any, count: int) -> tuple[float, ...] | None:
    if value is None:
        return None
    try:
        parts = value if isinstance(value, (list, tuple)) else str(value).split("\\")
        numbers = tuple(float(part) for part in parts)
    except (TypeError, ValueError, OverflowError):
        return None
    if len(numbers) != count or not all(math.isfinite(number) for number in numbers):
        return None
    return numbers


def _number(value: str | None) -> float | None:
    try:
        number = float(value) if value is not None else None
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number is not None and math.isfinite(number) else None


def _integer(value: str | None) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def _required_uid(dataset: Dataset, keyword: str) -> str | None:
    value = _safe_value(dataset, keyword)
    text = str(value).strip() if value is not None else ""
    return text if _valid_uid(text) else None


def _valid_uid(value: str) -> bool:
    if len(value) > 64 or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value):
        return False
    return all(part == "0" or not part.startswith("0") for part in value.split("."))


def _frame_count(dataset: Dataset) -> int | None:
    value = _safe_value(dataset, "NumberOfFrames")
    if value is None:
        return 1
    try:
        count = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return count if count > 0 else None


def _has_direct_geometry(dataset: Dataset) -> bool:
    return _safe_value(dataset, "ImagePositionPatient") is not None and _safe_value(
        dataset, "ImageOrientationPatient"
    ) is not None


def _different_patient(existing: dict[str, str], incoming: dict[str, str]) -> bool:
    for name in ("PatientID", "PatientName"):
        if existing.get(name) and incoming.get(name) and existing[name] != incoming[name]:
            return True
    return False


def _details(label: str, values: dict[str, str], names: Iterable[str]) -> dict[str, str]:
    details = {"humanLabel": label}
    details.update({name: values[name] for name in names if values.get(name)})
    return details


def _same_vectors(vectors: list[tuple[float, ...] | None], tolerance: float) -> bool:
    first = vectors[0] if vectors else None
    return first is not None and all(
        vector is not None and _close_vectors(first, vector, tolerance) for vector in vectors
    )


def _close_vectors(left: tuple[float, ...], right: tuple[float, ...], tolerance: float) -> bool:
    return len(left) == len(right) and all(abs(a - b) <= tolerance for a, b in zip(left, right))


def _valid_orientation(orientation: tuple[float, ...]) -> bool:
    if len(orientation) != 6:
        return False
    row, column = orientation[:3], orientation[3:]
    return (
        abs(_length(row) - 1) <= 0.01
        and abs(_length(column) - 1) <= 0.01
        and abs(_dot(row, column)) <= 0.01
    )


def _normal(orientation: tuple[float, ...]) -> tuple[float, float, float]:
    row, column = orientation[:3], orientation[3:]
    cross = (
        row[1] * column[2] - row[2] * column[1],
        row[2] * column[0] - row[0] * column[2],
        row[0] * column[1] - row[1] * column[0],
    )
    length = _length(cross)
    return tuple(value / length for value in cross)


def _dot(left: tuple[float, ...], right: tuple[float, ...]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _length(vector: tuple[float, ...]) -> float:
    return math.sqrt(_dot(vector, vector))


def _mixed_frame_of_reference(frames: list[_CatalogFrame]) -> bool:
    values = {frame.frame_of_reference for frame in frames}
    return len(values) > 1


def _mixed_temporal_positions(frames: list[_CatalogFrame]) -> bool:
    for name in _TEMPORAL_TAGS:
        values = {frame.temporal.get(name) for frame in frames}
        present = {value for value in values if value is not None}
        if len(present) > 1 or (present and None in values):
            return True
    return False


def _mixed_optional_spacing(values: list[float | None]) -> bool:
    present = [value for value in values if value is not None]
    if not present:
        return False
    if len(present) != len(values):
        return True
    tolerance = max(0.01, median(present) * 0.01)
    return max(present) - min(present) > tolerance


def _multiframe_position_reason(frames: list[_CatalogFrame]) -> str:
    if any(frame.multiframe for frame in frames):
        tags = [frame.public.tags for frame in frames]
        if any("FrameTime" in values or "FrameTimeVector" in values for values in tags):
            return "legacy cine frames have no per-frame slice positions"
        return "multi-frame object has no complete per-frame slice positions"
    return "missing slice positions"


def _in_plane_drift(
    frames: list[_CatalogFrame], normal: tuple[float, float, float],
) -> bool:
    spacing = [
        value
        for frame in frames
        if frame.pixel_spacing
        for value in frame.pixel_spacing
    ]
    tolerance = max(0.1, min(spacing, default=1.0) * 0.1)
    for left, right in zip(frames, frames[1:]):
        delta = tuple(b - a for a, b in zip(left.position or (), right.position or ()))
        projected = _dot(delta, normal)
        in_plane = tuple(value - projected * axis for value, axis in zip(delta, normal))
        if _length(in_plane) > tolerance:
            return True
    return False
