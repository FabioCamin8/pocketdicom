import base64
import operator
import pathlib

from pydicom import dcmread
from pydicom.tag import Tag


_MAX_OVERLAY_BYTES = 4 * 1024**2
_GROUPS = range(0x6000, 0x6020, 2)
_READ_TAGS = [Tag(0x0028, 0x0008)] + [
    Tag(group, element) for group in _GROUPS
    for element in (0x0010, 0x0011, 0x0015, 0x0050, 0x0051, 0x3000)
]


def _integer(value):
    if isinstance(value, bool):
        raise ValueError
    return operator.index(value)


def _element_value(dataset, group, element):
    tag = Tag(group, element)
    if tag not in dataset:
        raise KeyError(tag)
    return dataset[tag].value


def _optional_value(dataset, group, element, default):
    tag = Tag(group, element)
    return dataset[tag].value if tag in dataset else default


def _frame_mask(data, start_bit, pixel_count):
    byte_count = (pixel_count + 7) // 8
    mask = bytearray(byte_count)
    for output_index in range(byte_count):
        source_bit = start_bit + output_index * 8
        source_byte, shift = divmod(source_bit, 8)
        value = data[source_byte] >> shift
        if shift and source_byte + 1 < len(data):
            value |= data[source_byte + 1] << (8 - shift)
        mask[output_index] = value & 0xFF
    if pixel_count % 8:
        mask[-1] &= (1 << (pixel_count % 8)) - 1
    return bytes(mask)


def read_overlays(path: pathlib.Path, index: int) -> list[dict]:
    """Return separate DICOM overlay planes for a zero-based image frame."""
    if isinstance(index, bool):
        return []
    try:
        frame_index = operator.index(index)
    except TypeError:
        return []
    if frame_index < 0:
        return []

    dataset = dcmread(path, stop_before_pixels=True, specific_tags=_READ_TAGS, defer_size=32 * 1024)
    try:
        image_frame_count = _integer(_optional_value(dataset, 0x0028, 0x0008, 1))
    except (TypeError, ValueError, OverflowError):
        image_frame_count = 1
    if frame_index >= image_frame_count:
        return []

    encoding = getattr(dataset, 'original_encoding', None)
    little_endian = encoding[1] if encoding else None
    if little_endian is None:
        try:
            little_endian = dataset.file_meta.TransferSyntaxUID.is_little_endian
        except AttributeError:
            little_endian = True

    overlays = []
    image_frame = frame_index + 1
    for group in _GROUPS:
        data_tag = Tag(group, 0x3000)
        if data_tag not in dataset:
            continue
        try:
            rows = _integer(_element_value(dataset, group, 0x0010))
            columns = _integer(_element_value(dataset, group, 0x0011))
            origin = _element_value(dataset, group, 0x0050)
            if isinstance(origin, (str, bytes)) or len(origin) != 2:
                continue
            y = _integer(origin[0]) - 1
            x = _integer(origin[1]) - 1
            overlay_frame_count = _integer(_optional_value(dataset, group, 0x0015, 1))
            image_frame_origin = _integer(_optional_value(dataset, group, 0x0051, 1))
            if rows <= 0 or columns <= 0 or overlay_frame_count <= 0 or image_frame_origin < 1:
                continue

            overlay_frame = image_frame - image_frame_origin
            if overlay_frame < 0 or overlay_frame >= overlay_frame_count:
                continue

            pixel_count = rows * columns
            total_bits = pixel_count * overlay_frame_count
            expected_length = ((total_bits + 15) // 16) * 2
            raw_element = dataset.get_item(data_tag, keep_deferred=True)
            if (expected_length > _MAX_OVERLAY_BYTES or
                    getattr(raw_element, 'length', expected_length) != expected_length):
                continue
            raw_data = dataset[data_tag].value
            if not isinstance(raw_data, (bytes, bytearray, memoryview)) or len(raw_data) != expected_length:
                continue
            data = bytes(raw_data)
            if not little_endian:
                swapped = bytearray(len(data))
                swapped[::2], swapped[1::2] = data[1::2], data[::2]
                data = swapped

            mask = _frame_mask(data, overlay_frame * pixel_count, pixel_count)
            overlays.append({
                'x': x,
                'y': y,
                'width': columns,
                'height': rows,
                'mask': base64.b64encode(mask).decode('ascii'),
            })
        except (AttributeError, IndexError, KeyError, TypeError, ValueError, OverflowError):
            continue

    return overlays
