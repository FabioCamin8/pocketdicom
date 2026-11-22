from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from pydicom import dcmread
from pydicom.encaps import encapsulate
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.tag import Tag
from pydicom.uid import (
    ExplicitVRLittleEndian,
    JPEGBaseline8Bit,
    JPEG2000Lossless,
    RLELossless,
    SecondaryCaptureImageStorage,
    generate_uid,
)

from dicom_pixels import encode_frame


def write_synthetic_dicom(
    path: Path,
    pixels: np.ndarray,
    *,
    photometric: str = "MONOCHROME2",
    pixel_spacing: tuple[float, float] | None = None,
    color: bool | None = None,
) -> None:
    """Write a synthetic DICOM image; never reads a clinical fixture."""
    pixels = np.asarray(pixels)
    if color is None:
        color = photometric in {"RGB", "YBR_FULL", "YBR_FULL_422"}
    frames = pixels.shape[0] if pixels.ndim == (4 if color else 3) else 1
    rows, columns = pixels.shape[-3:-1] if color else pixels.shape[-2:]

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "OT"
    ds.Rows = rows
    ds.Columns = columns
    ds.SamplesPerPixel = 3 if color else 1
    ds.PhotometricInterpretation = photometric
    if color:
        ds.PlanarConfiguration = 0
    ds.BitsAllocated = pixels.dtype.itemsize * 8
    ds.BitsStored = ds.BitsAllocated
    ds.HighBit = ds.BitsStored - 1
    ds.PixelRepresentation = int(np.issubdtype(pixels.dtype, np.signedinteger))
    if frames > 1:
        ds.NumberOfFrames = frames
    if pixel_spacing is not None:
        ds.PixelSpacing = list(pixel_spacing)
    ds.PixelData = pixels.tobytes(order="C")
    ds.save_as(path, enforce_file_format=True)


def item(**attributes: object) -> Dataset:
    result = Dataset()
    for name, value in attributes.items():
        setattr(result, name, value)
    return result


def frame_values(body: bytes) -> np.ndarray:
    return np.frombuffer(body, dtype="<f4")


def test_encode_frame_returns_rescaled_signed_frame_and_contract_headers(tmp_path: Path) -> None:
    path = tmp_path / "synthetic.dcm"
    pixels = np.array([[[0, -2], [3, 4]], [[-1, 2], [-3, 5]]], dtype=np.int16)
    write_synthetic_dicom(path, pixels, pixel_spacing=(0.5, 0.75))
    # Add standard modality and display metadata to the synthetic file.
    synthetic = dcmread(path)
    synthetic.RescaleSlope = 2
    synthetic.RescaleIntercept = -1
    synthetic.WindowCenter = 50
    synthetic.WindowWidth = 100
    synthetic.PhotometricInterpretation = "MONOCHROME1"
    synthetic.save_as(path, enforce_file_format=True)

    body, headers = encode_frame(path, 1)

    np.testing.assert_array_equal(frame_values(body), [-3, 3, -7, 9])
    assert len(body) == 2 * 2 * 4
    assert headers == {
        "X-Width": "2",
        "X-Height": "2",
        "X-Type": "f32",
        "X-Window-Center": "50",
        "X-Window-Width": "100",
        "X-Invert": "1",
        "X-Pixel-Spacing": "0.5,0.75",
    }
    assert body[:4] == b"\x00\x00\x40\xc0"


def test_unsigned_pixels_are_not_sign_extended(tmp_path: Path) -> None:
    path = tmp_path / "unsigned.dcm"
    write_synthetic_dicom(path, np.array([[0, 32768, 65535]], dtype=np.uint16))

    body, headers = encode_frame(path, 0)

    np.testing.assert_array_equal(frame_values(body), [0, 32768, 65535])
    assert headers["X-Invert"] == "0"


def test_rgb_pixels_remain_interleaved_uint8(tmp_path: Path) -> None:
    path = tmp_path / "rgb.dcm"
    pixels = np.array([[[255, 0, 10], [4, 5, 6]]], dtype=np.uint8)
    write_synthetic_dicom(path, pixels, photometric="RGB")

    body, headers = encode_frame(path, 0)

    assert body == bytes([255, 0, 10, 4, 5, 6])
    assert headers["X-Type"] == "rgb"
    assert headers["X-Invert"] == "0"


def test_rgb_samples_are_scaled_from_bits_stored_to_uint8(tmp_path: Path) -> None:
    path = tmp_path / "rgb-12-bit.dcm"
    pixels = np.array([[[0, 2048, 4095]]], dtype=np.uint16)
    write_synthetic_dicom(path, pixels, photometric="RGB")
    synthetic = dcmread(path)
    synthetic.BitsStored = 12
    synthetic.HighBit = 11
    synthetic.save_as(path, enforce_file_format=True)

    body, headers = encode_frame(path, 0)

    assert body == bytes([0, 128, 255])
    assert headers["X-Type"] == "rgb"


def test_frame_functional_groups_override_shared_then_top_level_metadata(tmp_path: Path) -> None:
    path = tmp_path / "groups.dcm"
    write_synthetic_dicom(path, np.array([[[1, 2]], [[1, 2]]], dtype=np.uint16))
    synthetic = dcmread(path)
    synthetic.RescaleSlope = 10
    synthetic.RescaleIntercept = 100
    synthetic.PixelSpacing = [0.8, 0.9]
    synthetic.WindowCenter = 30
    synthetic.WindowWidth = 40
    shared = item(
        PixelMeasuresSequence=[item(PixelSpacing=[0.6, 0.7])],
        PixelValueTransformationSequence=[item(RescaleSlope=2, RescaleIntercept=3)],
        FrameVOILUTSequence=[item(WindowCenter=40, WindowWidth=50)],
    )
    synthetic.SharedFunctionalGroupsSequence = [shared]
    synthetic.PerFrameFunctionalGroupsSequence = [
        item(),
        item(
            PixelMeasuresSequence=[item(PixelSpacing=[0.2, 0.3])],
            PixelValueTransformationSequence=[
                item(RescaleSlope=-1, RescaleIntercept=20)
            ],
            FrameVOILUTSequence=[item(WindowCenter=70, WindowWidth=80)],
        ),
    ]
    synthetic.save_as(path, enforce_file_format=True)

    shared_body, shared_headers = encode_frame(path, 0)
    frame_body, frame_headers = encode_frame(path, 1)

    np.testing.assert_array_equal(frame_values(shared_body), [5, 7])
    assert shared_headers["X-Pixel-Spacing"] == "0.6,0.7"
    assert shared_headers["X-Window-Center"] == "40"
    assert shared_headers["X-Window-Width"] == "50"
    np.testing.assert_array_equal(frame_values(frame_body), [19, 18])
    assert frame_headers["X-Pixel-Spacing"] == "0.2,0.3"
    assert frame_headers["X-Window-Center"] == "70"
    assert frame_headers["X-Window-Width"] == "80"


def test_modality_lut_is_applied_before_float32_encoding(tmp_path: Path) -> None:
    path = tmp_path / "lut.dcm"
    write_synthetic_dicom(path, np.array([[0, 1]], dtype=np.uint8))
    synthetic = dcmread(path)
    synthetic.ModalityLUTSequence = [
        item(
            LUTDescriptor=[2, 0, 8],
            LUTExplanation="synthetic",
            ModalityLUTType="US",
            LUTData=bytes([10, 0, 20, 0]),
        )
    ]
    synthetic.save_as(path, enforce_file_format=True)

    body, headers = encode_frame(path, 0)

    np.testing.assert_array_equal(frame_values(body), [10, 20])
    assert headers["X-Window-Center"] == "15"
    assert headers["X-Window-Width"] == "10"


def test_invalid_window_and_spacing_fall_back_to_finite_values(tmp_path: Path) -> None:
    path = tmp_path / "invalid-metadata.dcm"
    write_synthetic_dicom(path, np.array([[2, 8]], dtype=np.uint8))
    synthetic = dcmread(path)
    synthetic.WindowCenter = "NaN"
    synthetic.WindowWidth = "Infinity"
    synthetic.PixelSpacing = ["NaN", "0.5"]
    synthetic.save_as(path, enforce_file_format=True)

    _, headers = encode_frame(path, 0)

    assert headers["X-Window-Center"] == "5"
    assert headers["X-Window-Width"] == "6"
    assert headers["X-Pixel-Spacing"] == ""
    assert np.isfinite(float(headers["X-Window-Center"]))
    assert np.isfinite(float(headers["X-Window-Width"]))


def test_window_alternatives_keep_center_width_pairing(tmp_path: Path) -> None:
    path = tmp_path / "window-alternatives.dcm"
    write_synthetic_dicom(path, np.array([[0, 255]], dtype=np.uint8))
    synthetic = dcmread(path)
    synthetic.WindowCenter = ["NaN", 50]
    synthetic.WindowWidth = [10, 100]
    synthetic.save_as(path, enforce_file_format=True)

    _, headers = encode_frame(path, 0)

    assert headers["X-Window-Center"] == "50"
    assert headers["X-Window-Width"] == "100"


def test_palette_color_becomes_interleaved_rgb(tmp_path: Path) -> None:
    path = tmp_path / "palette.dcm"
    write_synthetic_dicom(path, np.array([[0, 1]], dtype=np.uint8), photometric="PALETTE COLOR")
    synthetic = dcmread(path)
    for channel, values, descriptor_tag in (
        ("Red", [0, 255], 0x00281101),
        ("Green", [0, 0], 0x00281102),
        ("Blue", [0, 0], 0x00281103),
    ):
        setattr(synthetic, f"{channel}PaletteColorLookupTableDescriptor", [2, 0, 8])
        setattr(synthetic, f"{channel}PaletteColorLookupTableData", bytes(values))
        synthetic[Tag(descriptor_tag)].VR = "US"
    synthetic.save_as(path, enforce_file_format=True)

    body, headers = encode_frame(path, 0)

    assert body == bytes([0, 0, 0, 255, 0, 0])
    assert headers["X-Type"] == "rgb"
    assert headers["X-Window-Center"] == "127.5"
    assert headers["X-Window-Width"] == "255"


def test_ybr_color_is_converted_to_interleaved_rgb(tmp_path: Path) -> None:
    path = tmp_path / "ybr.dcm"
    write_synthetic_dicom(
        path,
        np.array([[[76, 85, 255]]], dtype=np.uint8),
        photometric="YBR_FULL",
    )

    body, headers = encode_frame(path, 0)

    np.testing.assert_array_equal(np.frombuffer(body, dtype=np.uint8), [254, 0, 0])
    assert headers["X-Type"] == "rgb"


def test_rle_compressed_frame_uses_pydicom_decoder(tmp_path: Path) -> None:
    path = tmp_path / "rle.dcm"
    write_synthetic_dicom(path, np.array([[1, 2], [3, 4]], dtype=np.uint16))
    synthetic = dcmread(path)
    synthetic.compress(RLELossless)
    synthetic.save_as(path, enforce_file_format=True)

    body, _ = encode_frame(path, 0)

    np.testing.assert_array_equal(frame_values(body), [1, 2, 3, 4])


def test_jpeg_baseline_frame_uses_pydicom_decoder(tmp_path: Path) -> None:
    path = tmp_path / "jpeg-baseline.dcm"
    pixels = np.full((2, 2), 128, dtype=np.uint8)
    write_synthetic_dicom(path, pixels)
    synthetic = dcmread(path)
    encoded = BytesIO()
    Image.fromarray(pixels).save(encoded, format="JPEG", quality=90)
    synthetic.file_meta.TransferSyntaxUID = JPEGBaseline8Bit
    synthetic.PixelData = encapsulate([encoded.getvalue()])
    synthetic[Tag(0x7FE00010)].is_undefined_length = True
    synthetic.save_as(path, enforce_file_format=True)

    body, _ = encode_frame(path, 0)

    np.testing.assert_array_equal(frame_values(body), [128, 128, 128, 128])


def test_jpeg2000_lossless_frame_uses_pydicom_decoder(tmp_path: Path) -> None:
    path = tmp_path / "jpeg2000.dcm"
    pixels = np.arange(1024, dtype=np.uint16).reshape(32, 32)
    write_synthetic_dicom(path, pixels)
    synthetic = dcmread(path)
    synthetic.compress(JPEG2000Lossless)
    synthetic.save_as(path, enforce_file_format=True)

    body, _ = encode_frame(path, 0)

    np.testing.assert_array_equal(frame_values(body), pixels.ravel())


def test_oversized_declared_frame_is_rejected_before_pixel_decode(tmp_path: Path) -> None:
    path = tmp_path / "oversized.dcm"
    write_synthetic_dicom(path, np.array([[1, 2]], dtype=np.uint8))
    synthetic = dcmread(path)
    synthetic.Rows = 4000
    synthetic.Columns = 4001
    synthetic.save_as(path, enforce_file_format=True)

    with pytest.raises(ValueError, match="dimensions"):
        encode_frame(path, 0)


def test_negative_or_out_of_range_frame_index_fails(tmp_path: Path) -> None:
    path = tmp_path / "one-frame.dcm"
    write_synthetic_dicom(path, np.array([[1, 2]], dtype=np.uint8))

    for index in (-1, 1):
        with pytest.raises((IndexError, ValueError)):
            encode_frame(path, index)
