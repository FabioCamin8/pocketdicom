from pathlib import Path

from pydicom import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import (
    CTImageStorage,
    EnhancedCTImageStorage,
    ExplicitVRLittleEndian,
    generate_uid,
)

from dicom_catalog import build_catalog


def _patch_raw(path: Path, old: bytes, new: bytes) -> None:
    """Replace one equally-sized raw value without changing the DICOM layout."""
    assert len(old) == len(new)
    data = path.read_bytes()
    assert data.count(old) == 1
    path.write_bytes(data.replace(old, new))


def _write_ct(
    path: Path,
    *,
    study_uid: str,
    series_uid: str,
    instance_uid: str,
    instance: int,
    position: tuple[float, float, float],
    include_pixel_data: bool = True,
    **attributes: object,
) -> Path:
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = instance_uid
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(path, {}, file_meta=file_meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = CTImageStorage
    dataset.SOPInstanceUID = instance_uid
    dataset.StudyInstanceUID = study_uid
    dataset.SeriesInstanceUID = series_uid
    dataset.PatientName = "Synthetic^Patient"
    dataset.PatientID = "SYNTHETIC-001"
    dataset.StudyDate = "20260102"
    dataset.StudyDescription = "Synthetic chest study"
    dataset.SeriesDescription = "Axial CT"
    dataset.Modality = "CT"
    dataset.FrameOfReferenceUID = "1.2.826.0.1.3680043.10.5432"
    dataset.InstanceNumber = instance
    dataset.Rows = 32
    dataset.Columns = 32
    dataset.SamplesPerPixel = 1
    dataset.BitsAllocated = 16
    dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    dataset.PixelSpacing = [0.7, 0.7]
    dataset.SpacingBetweenSlices = 1
    dataset.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    dataset.ImagePositionPatient = list(position)
    dataset.PhotometricInterpretation = "MONOCHROME2"
    for name, value in attributes.items():
        setattr(dataset, name, value)
    if include_pixel_data:
        frames = int(getattr(dataset, "NumberOfFrames", 1))
        sample_count = int(getattr(dataset, "SamplesPerPixel", 1))
        dataset.PixelData = bytes(dataset.Rows * dataset.Columns * frames * sample_count * 2)
    dataset.save_as(path, enforce_file_format=True)
    return path


def _write_enhanced_ct(
    path: Path,
    per_frame_pixel_spacings: tuple[tuple[float, float] | None, ...] = (None, None, None),
) -> Path:
    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = EnhancedCTImageStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(path, {}, file_meta=file_meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = EnhancedCTImageStorage
    dataset.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    dataset.StudyInstanceUID = generate_uid()
    dataset.SeriesInstanceUID = generate_uid()
    dataset.FrameOfReferenceUID = generate_uid()
    dataset.PatientName = "Synthetic^Enhanced"
    dataset.PatientID = "SYNTHETIC-ENHANCED"
    dataset.Modality = "CT"
    dataset.Rows = 16
    dataset.Columns = 16
    dataset.SamplesPerPixel = 1
    dataset.BitsAllocated = 16
    dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.NumberOfFrames = 3

    shared = Dataset()
    measures = Dataset()
    measures.PixelSpacing = [0.8, 0.8]
    measures.SpacingBetweenSlices = 1.5
    shared.PixelMeasuresSequence = [measures]
    plane = Dataset()
    plane.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    shared.PlaneOrientationSequence = [plane]
    dataset.SharedFunctionalGroupsSequence = [shared]

    dataset.PerFrameFunctionalGroupsSequence = []
    for z, pixel_spacing in zip((3, 0, 1.5), per_frame_pixel_spacings):
        frame_group = Dataset()
        position = Dataset()
        position.ImagePositionPatient = [0, 0, z]
        frame_group.PlanePositionSequence = [position]
        content = Dataset()
        content.InStackPositionNumber = len(dataset.PerFrameFunctionalGroupsSequence) + 1
        frame_group.FrameContentSequence = [content]
        if pixel_spacing is not None:
            measures = Dataset()
            measures.PixelSpacing = list(pixel_spacing)
            frame_group.PixelMeasuresSequence = [measures]
        dataset.PerFrameFunctionalGroupsSequence.append(frame_group)

    dataset.PixelData = bytes(16 * 16 * 3 * 2)
    dataset.save_as(path, enforce_file_format=True)
    return path


def test_catalog_groups_study_series_and_sorts_axial_frames(tmp_path: Path) -> None:
    study_uid = generate_uid()
    series_uid = generate_uid()
    paths = [
        _write_ct(
            tmp_path / f"slice-{instance}.dcm",
            study_uid=study_uid,
            series_uid=series_uid,
            instance_uid=generate_uid(),
            instance=instance,
            position=(0, 0, z),
        )
        for instance, z in ((3, 2), (1, 0), (2, 1))
    ]

    studies, frames, skipped = build_catalog(paths)

    assert skipped == 0
    assert len(studies) == 1
    study = studies[0]
    assert study["date"] == "20260102"
    assert study["patient"] == "Synthetic^Patient"
    assert study["details"]["StudyDescription"] == "Synthetic chest study"
    assert len(study["series"]) == 1
    series = study["series"][0]
    assert series["modality"] == "CT"
    assert [frame["instance"] for frame in series["frames"]] == [1, 2, 3]
    assert [frame["position"][2] for frame in series["frames"]] == [0, 1, 2]
    assert series["volume"] is True
    assert series["spacingZ"] == 1
    assert series["orientation"] == [1, 0, 0, 0, 1, 0]
    assert series["frameOfReference"] == "1.2.826.0.1.3680043.10.5432"
    assert all(frame["orientation"] == [1, 0, 0, 0, 1, 0] for frame in series["frames"])
    assert all(frame["pixelSpacing"] == [0.7, 0.7] for frame in series["frames"])
    assert len(frames) == 3
    assert all(frame.tags["PatientID"] == "SYNTHETIC-001" for frame in frames.values())
    assert {frame.path for frame in frames.values()} == set(paths)


def test_catalog_skips_dicomdir_sidecars_and_malformed_files(tmp_path: Path) -> None:
    valid = _write_ct(
        tmp_path / "valid.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
    )
    dicomdir = _write_ct(
        tmp_path / "DICOMDIR",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
    )
    sidecar = tmp_path / "metadata.json"
    sidecar.write_text('{"synthetic": true}', encoding="utf-8")
    malformed = tmp_path / "broken.dcm"
    malformed.write_bytes(b"not a DICOM object")

    studies, frames, skipped = build_catalog([valid, dicomdir, sidecar, malformed])

    assert skipped == 3
    assert len(studies) == 1
    assert len(frames) == 1


def test_inputs_without_pixel_data_are_skipped_not_exposed_as_frames(tmp_path: Path) -> None:
    missing_pixel = _write_ct(
        tmp_path / "missing-pixel.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        include_pixel_data=False,
    )
    report = tmp_path / "report-no-image.dcm"
    # This synthetic object stands in for a non-image report object.
    from pydicom.uid import ComprehensiveSRStorage

    report_dataset = FileDataset(report, {}, file_meta=FileMetaDataset(), preamble=b"\0" * 128)
    report_dataset.file_meta.MediaStorageSOPClassUID = ComprehensiveSRStorage
    report_dataset.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    report_dataset.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    report_dataset.SOPClassUID = ComprehensiveSRStorage
    report_dataset.SOPInstanceUID = report_dataset.file_meta.MediaStorageSOPInstanceUID
    report_dataset.StudyInstanceUID = generate_uid()
    report_dataset.SeriesInstanceUID = generate_uid()
    report_dataset.Modality = "SR"
    report_dataset.DocumentTitle = "Synthetic report"
    report_dataset.save_as(report, enforce_file_format=True)

    studies, frames, skipped = build_catalog([missing_pixel, report])

    assert skipped == 2
    assert studies == []
    assert frames == {}


def test_truncated_native_pixel_data_is_skipped_without_decoding(tmp_path: Path) -> None:
    path = _write_ct(
        tmp_path / "truncated-pixel.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
    )
    with path.open("r+b") as stream:
        stream.truncate(path.stat().st_size - 50)

    studies, frames, skipped = build_catalog([path])

    assert (studies, frames, skipped) == ([], {}, 1)


def test_single_image_stays_visible_as_2d(tmp_path: Path) -> None:
    path = _write_ct(
        tmp_path / "single.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=7,
        position=(0, 0, 0),
    )

    studies, frames, skipped = build_catalog([path])

    series = studies[0]["series"][0]
    assert skipped == 0
    assert series["volume"] is False
    assert series["volumeReason"] == "single image"
    assert len(series["frames"]) == len(frames) == 1
    assert series["frames"][0]["instance"] == 7


def test_axial_order_uses_slice_normal_not_patient_z(tmp_path: Path) -> None:
    study_uid = generate_uid()
    series_uid = generate_uid()
    paths = [
        _write_ct(
            tmp_path / f"oblique-{index}.dcm",
            study_uid=study_uid,
            series_uid=series_uid,
            instance_uid=generate_uid(),
            instance=index + 1,
            position=(x, 20, 30),
            ImageOrientationPatient=[0, 1, 0, 0, 0, 1],
        )
        for index, x in enumerate((2, 0, 1))
    ]

    studies, _, _ = build_catalog(paths)

    assert [frame["position"][0] for frame in studies[0]["series"][0]["frames"]] == [0, 1, 2]


def test_mixed_orientations_keep_instance_order_in_2d(tmp_path: Path) -> None:
    study_uid, series_uid = generate_uid(), generate_uid()
    paths = []
    for instance, z in ((1, 2), (2, 0), (3, 1)):
        attributes = {"ImageOrientationPatient": [0, 1, 0, -1, 0, 0]} if instance == 3 else {}
        paths.append(
            _write_ct(
                tmp_path / f"mixed-orientation-{instance}.dcm",
                study_uid=study_uid,
                series_uid=series_uid,
                instance_uid=generate_uid(),
                instance=instance,
                position=(0, 0, z),
                **attributes,
            )
        )

    studies, _, _ = build_catalog(paths)

    series = studies[0]["series"][0]
    assert [frame["instance"] for frame in series["frames"]] == [1, 2, 3]
    assert series["volume"] is False


def test_enhanced_frames_use_per_frame_geometry_without_pixel_decode(tmp_path: Path) -> None:
    path = _write_enhanced_ct(tmp_path / "enhanced.dcm")

    studies, frames, skipped = build_catalog([path])

    series = studies[0]["series"][0]
    records = series["frames"]
    assert skipped == 0
    assert len(records) == 3
    assert [record["position"][2] for record in records] == [0, 1.5, 3]
    assert [frames[record["id"]].index for record in records] == [1, 2, 0]
    assert series["volume"] is True
    assert series["spacingZ"] == 1.5
    assert series["frameOfReference"] == next(iter(frames.values())).tags["FrameOfReferenceUID"]
    assert all(record["orientation"] == [1, 0, 0, 0, 1, 0] for record in records)
    assert all(record["pixelSpacing"] == [0.8, 0.8] for record in records)
    assert all("PixelData" not in frame.tags for frame in frames.values())
    assert len({study["id"] for study in studies}) == len({series["id"] for study in studies for series in study["series"]}) == 1


def test_enhanced_per_frame_pixel_spacing_is_reported_and_blocks_mixed_volume(tmp_path: Path) -> None:
    path = _write_enhanced_ct(
        tmp_path / "enhanced-mixed-spacing.dcm",
        per_frame_pixel_spacings=(None, None, (0.6, 0.7)),
    )

    studies, _, skipped = build_catalog([path])

    series = studies[0]["series"][0]
    assert skipped == 0
    assert [frame["position"][2] for frame in series["frames"]] == [0, 1.5, 3]
    assert [frame["pixelSpacing"] for frame in series["frames"]] == [
        [0.8, 0.8],
        [0.6, 0.7],
        [0.8, 0.8],
    ]
    assert series["volume"] is False
    assert series["volumeReason"] == "missing or mixed in-plane pixel spacing"


def test_legacy_cine_is_visible_but_not_a_spatial_volume(tmp_path: Path) -> None:
    path = _write_ct(
        tmp_path / "cine.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        NumberOfFrames=3,
        FrameTime=40,
    )

    studies, frames, skipped = build_catalog([path])

    series = studies[0]["series"][0]
    assert skipped == 0
    assert len(frames) == 3
    assert [frames[item["id"]].index for item in series["frames"]] == [0, 1, 2]
    assert series["volume"] is False
    assert "cine" in series["volumeReason"]


def test_document_report_metadata_is_cataloged_without_report_body(tmp_path: Path) -> None:
    path = _write_ct(
        tmp_path / "report.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        DocumentTitle="Synthetic report title",
        CompletionFlag="COMPLETE",
        VerificationFlag="UNVERIFIED",
    )

    studies, frames, _ = build_catalog([path])

    tags = next(iter(frames.values())).tags
    assert tags["DocumentTitle"] == "Synthetic report title"
    assert tags["CompletionFlag"] == "COMPLETE"
    assert tags["VerificationFlag"] == "UNVERIFIED"
    assert "ContentSequence" not in tags


def test_legacy_charset_override_decodes_mislabelled_text(tmp_path: Path, monkeypatch) -> None:
    expected = "Привет"
    legacy_path = _write_ct(
        tmp_path / "legacy-missing.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        StudyDescription="LEGACY",
    )
    _patch_raw(legacy_path, b"LEGACY", expected.encode("cp1251"))

    monkeypatch.delenv("POCKET_DICOM_LEGACY_CHARSET", raising=False)
    default_studies, default_frames, _ = build_catalog([legacy_path])
    default_label = default_studies[0]["label"]
    assert default_label != expected
    assert next(iter(default_frames.values())).tags["StudyDescription"] == default_label

    monkeypatch.setenv("POCKET_DICOM_LEGACY_CHARSET", "cp1251")
    studies, frames, skipped = build_catalog([legacy_path])

    frame = next(iter(frames.values()))
    assert skipped == 0
    assert studies[0]["label"] == expected
    assert studies[0]["details"]["StudyDescription"] == expected
    assert frame.tags["StudyDescription"] == expected

    for declaration in ("", "ISO_IR 6"):
        path = _write_ct(
            tmp_path / f"legacy-{declaration or 'empty'}.dcm",
            study_uid=generate_uid(),
            series_uid=generate_uid(),
            instance_uid=generate_uid(),
            instance=1,
            position=(0, 0, 0),
            StudyDescription="LEGACY",
            SpecificCharacterSet=declaration,
        )
        _patch_raw(path, b"LEGACY", expected.encode("cp1251"))
        studies, frames, _ = build_catalog([path])
        assert studies[0]["label"] == expected
        assert next(iter(frames.values())).tags["StudyDescription"] == expected


def test_legacy_charset_override_keeps_declared_utf8(tmp_path: Path, monkeypatch) -> None:
    expected = "Привет"
    path = _write_ct(
        tmp_path / "declared-utf8.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        StudyDescription=expected,
        SpecificCharacterSet="ISO_IR 192",
    )
    assert expected.encode("utf-8") in path.read_bytes()
    monkeypatch.setenv("POCKET_DICOM_LEGACY_CHARSET", "cp1251")

    studies, frames, skipped = build_catalog([path])

    assert skipped == 0
    assert studies[0]["label"] == expected
    assert next(iter(frames.values())).tags["StudyDescription"] == expected


def test_legacy_charset_override_keeps_valid_iso2022_person_name(
    tmp_path: Path, monkeypatch,
) -> None:
    expected = "Yamada^Tarou=山田^太郎"
    encoded = expected.encode("iso2022_jp")
    assert b"\x1b" in encoded
    path = _write_ct(
        tmp_path / "declared-iso2022.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        PatientName="Z" * len(encoded),
        SpecificCharacterSet=["ISO 2022 IR 87"],
    )
    _patch_raw(path, b"Z" * len(encoded), encoded)
    monkeypatch.setenv("POCKET_DICOM_LEGACY_CHARSET", "shift_jis")

    studies, frames, skipped = build_catalog([path])

    assert skipped == 0
    assert studies[0]["patient"] == expected
    assert next(iter(frames.values())).tags["PatientName"] == expected


def test_failed_legacy_override_uses_existing_decoding(tmp_path: Path, monkeypatch) -> None:
    path = _write_ct(
        tmp_path / "legacy-invalid.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        StudyDescription="FAIL",
    )
    _patch_raw(path, b"FAIL", b"\x98BAD")

    monkeypatch.delenv("POCKET_DICOM_LEGACY_CHARSET", raising=False)
    default_studies, _, _ = build_catalog([path])
    default_label = default_studies[0]["label"]

    monkeypatch.setenv("POCKET_DICOM_LEGACY_CHARSET", "cp1251")
    studies, frames, skipped = build_catalog([path])

    assert skipped == 0
    assert studies[0]["label"] == default_label
    assert next(iter(frames.values())).tags["StudyDescription"] == default_label


def test_unsupported_legacy_charset_is_ignored(tmp_path: Path, monkeypatch) -> None:
    expected = "Привет"
    path = _write_ct(
        tmp_path / "legacy-unsupported.dcm",
        study_uid=generate_uid(),
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
        StudyDescription="LEGACY",
    )
    _patch_raw(path, b"LEGACY", expected.encode("cp1251"))

    monkeypatch.delenv("POCKET_DICOM_LEGACY_CHARSET", raising=False)
    default_label = build_catalog([path])[0][0]["label"]

    monkeypatch.setenv("POCKET_DICOM_LEGACY_CHARSET", "latin-1")
    studies, _, _ = build_catalog([path])
    assert studies[0]["label"] == default_label
    assert studies[0]["label"] != expected


def test_volume_is_rejected_for_unsafe_geometry(tmp_path: Path) -> None:
    cases = (
        ("gap", (0, 1, 3), {}, "irregular slice spacing or missing slices"),
        ("duplicate", (0, 1, 1), {}, "duplicate slice positions"),
        (
            "dimensions",
            (0, 1, 2),
            {2: {"Columns": 16}},
            "missing or mixed image dimensions",
        ),
        (
            "rotation",
            (0, 1, 2),
            {2: {"ImageOrientationPatient": [0, 1, 0, -1, 0, 0]}},
            "mixed image orientation or rotation",
        ),
        ("drift", (0, 1, 2), {2: {"ImagePositionPatient": [1, 0, 2]}}, "in-plane position drift"),
        (
            "color",
            (0, 1, 2),
            {1: {"SamplesPerPixel": 3, "PhotometricInterpretation": "RGB"}},
            "color or unsupported photometric interpretation",
        ),
        (
            "temporal",
            (0, 1, 2),
            {2: {"TemporalPositionIdentifier": 2}},
            "mixed temporal positions or acquisitions",
        ),
        (
            "frame-of-reference",
            (0, 1, 2),
            {2: {"FrameOfReferenceUID": generate_uid()}},
            "mixed frame of reference",
        ),
        (
            "slice-spacing",
            (0, 1, 2),
            {2: {"SpacingBetweenSlices": 2}},
            "mixed slice spacing metadata",
        ),
        (
            "scout",
            (0, 1, 2),
            {1: {"ImageType": ["ORIGINAL", "PRIMARY", "LOCALIZER"]}},
            "localizer/scout series",
        ),
    )
    for name, positions, changes, expected_reason in cases:
        study_uid, series_uid = generate_uid(), generate_uid()
        paths = []
        for index, z in enumerate(positions):
            attributes = changes.get(index, {})
            position = tuple(attributes.pop("ImagePositionPatient", (0, 0, z)))
            paths.append(
                _write_ct(
                    tmp_path / f"{name}-{index}.dcm",
                    study_uid=study_uid,
                    series_uid=series_uid,
                    instance_uid=generate_uid(),
                    instance=index + 1,
                    position=position,
                    **attributes,
                )
            )

        studies, frames, skipped = build_catalog(paths)

        series = studies[0]["series"][0]
        assert skipped == 0, name
        assert len(frames) == 3, name
        assert series["volume"] is False, name
        assert series["volumeReason"] == expected_reason, name


def test_path_limit_is_enforced_and_reported_as_skipped(tmp_path: Path, monkeypatch) -> None:
    paths = [
        _write_ct(
            tmp_path / f"limited-{index}.dcm",
            study_uid=generate_uid(),
            series_uid=generate_uid(),
            instance_uid=generate_uid(),
            instance=1,
            position=(0, 0, 0),
        )
        for index in range(3)
    ]
    monkeypatch.setattr("dicom_catalog.MAX_PATHS", 2)

    studies, frames, skipped = build_catalog(paths)

    assert skipped == 1
    assert len(studies) == 2
    assert len(frames) == 2


def test_missing_required_uid_is_skipped_individually(tmp_path: Path) -> None:
    path = _write_ct(
        tmp_path / "missing-study-uid.dcm",
        study_uid="",
        series_uid=generate_uid(),
        instance_uid=generate_uid(),
        instance=1,
        position=(0, 0, 0),
    )

    studies, frames, skipped = build_catalog([path])

    assert (studies, frames, skipped) == ([], {}, 1)


def test_per_instance_frame_limit_is_enforced(tmp_path: Path, monkeypatch) -> None:
    path = _write_enhanced_ct(tmp_path / "too-many-frames.dcm")
    monkeypatch.setattr("dicom_catalog.MAX_FRAMES_PER_INSTANCE", 2)

    studies, frames, skipped = build_catalog([path])

    assert (studies, frames, skipped) == ([], {}, 1)


def test_total_frame_limit_is_enforced_across_instances(tmp_path: Path, monkeypatch) -> None:
    study_uid, series_uid = generate_uid(), generate_uid()
    paths = [
        _write_ct(
            tmp_path / f"total-limit-{index}.dcm",
            study_uid=study_uid,
            series_uid=series_uid,
            instance_uid=generate_uid(),
            instance=index + 1,
            position=(0, 0, index),
        )
        for index in range(3)
    ]
    monkeypatch.setattr("dicom_catalog.MAX_TOTAL_FRAMES", 2)

    studies, frames, skipped = build_catalog(paths)

    assert skipped == 1
    assert len(frames) == 2
    assert len(studies[0]["series"][0]["frames"]) == 2
