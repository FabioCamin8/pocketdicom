import base64

from pydicom import FileDataset, FileMetaDataset
from pydicom.tag import Tag
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

import dicom_overlays
from dicom_overlays import read_overlays


def _overlay_data(bits):
    data = bytearray(max(2, ((len(bits) + 15) // 16) * 2))
    for bit_index, bit in enumerate(bits):
        if bit:
            data[bit_index // 8] |= 1 << (bit_index % 8)
    return bytes(data)


def _write_dicom(path, overlays, *, rows=4, columns=4, frames=4, pixel_data=None):
    uid = generate_uid()
    file_meta = FileMetaDataset()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.MediaStorageSOPClassUID = CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = uid
    ds = FileDataset(str(path), {}, file_meta=file_meta, preamble=bytes(128))
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = uid
    ds.Rows = rows
    ds.Columns = columns
    ds.NumberOfFrames = str(frames)
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelData = pixel_data if pixel_data is not None else bytes(rows * columns * frames)

    for group, plane in overlays.items():
        ds.add_new(Tag(group, 0x0010), 'US', plane.get('rows', 1))
        ds.add_new(Tag(group, 0x0011), 'US', plane.get('columns', 1))
        if 'origin' in plane:
            ds.add_new(Tag(group, 0x0050), 'SS', plane['origin'])
        if 'frames' in plane:
            ds.add_new(Tag(group, 0x0015), 'IS', str(plane['frames']))
        if 'image_frame_origin' in plane:
            ds.add_new(Tag(group, 0x0051), 'US', plane['image_frame_origin'])
        ds.add_new(Tag(group, 0x3000), 'OW', plane['data'])

    ds.save_as(path, enforce_file_format=True)


def test_reads_continuous_row_major_bits_and_converts_one_based_origin(tmp_path):
    path = tmp_path / 'synthetic.dcm'
    _write_dicom(path, {
        0x6000: {
            'rows': 2,
            'columns': 3,
            'origin': [0, -1],
            'data': _overlay_data([1, 0, 1, 1, 1, 0]),
        },
    })

    assert read_overlays(path, 0) == [{
        'x': -2,
        'y': -1,
        'width': 3,
        'height': 2,
        'mask': base64.b64encode(bytes([0b00011101])).decode('ascii'),
    }]


def test_selects_overlay_frame_using_one_based_image_frame_origin(tmp_path):
    path = tmp_path / 'synthetic.dcm'
    _write_dicom(path, {
        0x6000: {
            'rows': 2,
            'columns': 2,
            'origin': [1, 1],
            'frames': 2,
            'image_frame_origin': 2,
            'data': _overlay_data([1, 0, 0, 1, 0, 1, 1, 0]),
        },
    })

    assert read_overlays(path, 0) == []
    assert read_overlays(path, 1)[0]['mask'] == base64.b64encode(bytes([0b00001001])).decode('ascii')
    assert read_overlays(path, 2)[0]['mask'] == base64.b64encode(bytes([0b00000110])).decode('ascii')
    assert read_overlays(path, 3) == []


def test_skips_bad_and_oversized_planes_without_losing_valid_planes(tmp_path):
    path = tmp_path / 'synthetic.dcm'
    _write_dicom(path, {
        0x6000: {
            'rows': 2,
            'columns': 16,
            'origin': [1, 1],
            'data': b'\x01',
        },
        0x6002: {
            'rows': 1,
            'columns': 1,
            'origin': [1, 1],
            'data': b'\x01\x00\x02\x00',
        },
        0x6004: {
            'rows': 1,
            'columns': 2,
            'origin': [1],
            'data': _overlay_data([1, 0]),
        },
        0x6006: {
            'rows': 1,
            'columns': 1,
            'origin': [1, 1],
            'data': _overlay_data([1]),
        },
        0x6008: {
            'origin': [1, 1],
            'frames': 2,
            'image_frame_origin': 0,
            'data': _overlay_data([0, 1]),
        },
    })

    assert read_overlays(path, 0) == [{
        'x': 0,
        'y': 0,
        'width': 1,
        'height': 1,
        'mask': 'AQ==',
    }]


def test_ignores_legacy_overlay_bits_embedded_in_pixel_data(tmp_path):
    path = tmp_path / 'synthetic.dcm'
    _write_dicom(path, {}, rows=1, columns=1, frames=1, pixel_data=b'\xff')

    assert read_overlays(path, 0) == []


def test_valid_but_over_limit_overlay_plane_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setattr(dicom_overlays, '_MAX_OVERLAY_BYTES', 2, raising=False)
    path = tmp_path / 'synthetic.dcm'
    _write_dicom(path, {
        0x6000: {'rows': 4, 'columns': 8, 'origin': [1, 1], 'data': b'\xff' * 4},
        0x6002: {'rows': 1, 'columns': 1, 'origin': [1, 1], 'data': b'\x01\x00'},
    })

    assert read_overlays(path, 0) == [{'x': 0, 'y': 0, 'width': 1, 'height': 1, 'mask': 'AQ=='}]
