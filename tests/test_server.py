import gzip
import hashlib
import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

import server


def image_bytes(study=None, series=None, reference=None, z=None, rows=1,
                date='20261104', description='Synthetic scan', modality='CT',
                patient='Synthetic^Patient'):
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    ds = FileDataset(None, {}, file_meta=meta, preamble=bytes(128))
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = study or generate_uid()
    ds.SeriesInstanceUID = series or generate_uid()
    ds.PatientName = patient
    ds.StudyDescription = description
    ds.StudyDate = date
    ds.SeriesDescription = 'Synthetic series'
    ds.Modality = modality
    ds.Rows, ds.Columns = rows, 2
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME1'
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit, ds.PixelRepresentation = 15, 1
    ds.PixelSpacing = [0.5, 0.75]
    ds.RescaleIntercept, ds.RescaleSlope = -100, 2
    ds.WindowCenter, ds.WindowWidth = -110, 150
    ds.PixelData = np.array([-10, 5], dtype='<i2').tobytes() * rows
    if reference is not None:
        ds.FrameOfReferenceUID = reference
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.ImagePositionPatient = [11, 22, z]
    buffer = io.BytesIO()
    ds.save_as(buffer, enforce_file_format=True)
    return buffer.getvalue()


def client(**options):
    host = options.get('bind_host', '127.0.0.1')
    request_host = '192.168.10.1' if host == '0.0.0.0' else host
    return TestClient(server.create_app(**options), base_url=f'http://{request_host}:8765')


def first_frame(payload):
    return payload['studies'][0]['series'][0]['frames'][0]['id']


def test_import_extensionless_file_and_skip_each_non_image():
    with client() as api:
        response = api.post('/api/import', files=[
            ('files', ('EXTENSIONLESS', image_bytes())),
            ('files', ('DICOMDIR', image_bytes())),
            ('files', ('report.txt', b'not DICOM')),
            ('files', ('broken.dcm', b'broken')),
        ])
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        payload = response.json()
        session_id = payload['session']
        assert payload['skipped'] == 3
        assert len(payload['studies']) == 1
        study = payload['studies'][0]
        assert study['label'] == 'Synthetic scan'
        assert study['series'][0]['volume'] is False
        frame_id = first_frame(payload)
        frame = api.get(f'/api/frame/{session_id}/{frame_id}')
        assert frame.status_code == 200
        assert frame.headers['content-type'] == 'application/octet-stream'
        assert frame.headers['cache-control'] == 'no-store'
        assert frame.headers['x-width'] == '2'
        assert frame.headers['x-height'] == '1'
        assert frame.headers['x-type'] == 'f32'
        assert frame.headers['x-invert'] == '1'
        assert float(frame.headers['x-window-center']) == -110
        assert float(frame.headers['x-window-width']) == 150
        assert list(map(float, frame.headers['x-pixel-spacing'].split(','))) == [0.5, 0.75]
        assert np.frombuffer(frame.content, dtype='<f4').tolist() == [-120, -90]
        tags = api.get(f'/api/tags/{session_id}/{frame_id}').json()['tags']
        assert tags['StudyDescription'] == 'Synthetic scan'
        assert api.get(f'/api/overlays/{session_id}/{frame_id}').json() == {'overlays': []}
        assert api.get(f'/api/frame/{session_id}/wrong').status_code == 404
        assert api.get(f'/api/tags/wrong/{frame_id}').status_code == 404


def test_library_is_opt_in_and_does_not_follow_symlinks(tmp_path):
    with client() as api:
        assert api.get('/api/config').json() == {'library': False}
        assert api.post('/api/open-local').status_code == 404

    library = tmp_path / 'configured'
    child = library / 'nested'
    child.mkdir(parents=True)
    (child / 'valid').write_bytes(image_bytes())
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'other').write_bytes(image_bytes())
    (library / 'escape').symlink_to(outside / 'other')
    (library / 'escape-dir').symlink_to(outside, target_is_directory=True)
    with client(library=library) as api:
        assert api.get('/api/config').json() == {'library': True}
        result = api.post('/api/open-local', json={'path': str(outside)})
        assert result.status_code == 200
        payload = result.json()
        assert len(payload['studies']) == 1
        assert api.get(f"/api/frame/{payload['session']}/{first_frame(payload)}").status_code == 200


def test_linked_volumes_carry_matching_dicom_reference_and_frame_geometry():
    study = generate_uid()
    reference = generate_uid()
    series_ids = [generate_uid(), generate_uid()]
    files = [('files', ('slice', image_bytes(study, series, reference, z)))
             for series in series_ids for z in (13, 9, 11)]
    with client() as api:
        result = api.post('/api/import', files=files)
        assert result.status_code == 200
        volumes = result.json()['studies'][0]['series']
        assert len(volumes) == 2
        for volume in volumes:
            assert volume['volume'] is True
            assert volume['frameOfReference'] == reference
            assert volume['orientation'] == [1, 0, 0, 0, 1, 0]
            assert volume['spacingZ'] == 2
            assert [frame['position'] for frame in volume['frames']] == [[11, 22, 9], [11, 22, 11], [11, 22, 13]]
            for frame in volume['frames']:
                assert frame['orientation'] == [1, 0, 0, 0, 1, 0]
                assert frame['pixelSpacing'] == [0.5, 0.75]


def test_unreadable_local_entry_does_not_hide_other_images(tmp_path, monkeypatch):
    unreadable = tmp_path / 'unreadable'
    unreadable.write_bytes(image_bytes())
    (tmp_path / 'valid').write_bytes(image_bytes())
    original_stat = Path.stat

    def inaccessible(path, *, follow_symlinks=True):
        if path == unreadable and follow_symlinks:
            raise PermissionError('synthetic inaccessible file')
        return original_stat(path, follow_symlinks=follow_symlinks)

    with client(library=tmp_path) as api:
        monkeypatch.setattr(Path, 'stat', inaccessible)
        result = api.post('/api/open-local')
        assert result.status_code == 200
        data = result.json()
        assert data['skipped'] == 1
        assert len(data['studies']) == 1


@pytest.mark.parametrize('headers', [
    {'Host': 'example.invalid:8765'},
    {'Host': 'localhost.attacker.invalid:8765'},
    {'Host': '[127.0.0.1:8765'},
    {'Origin': 'http://example.invalid:8765'},
    {'Origin': 'http://127.0.0.1:8766'},
    {'Origin': 'null'},
    {'Sec-Fetch-Site': 'cross-site'},
])
def test_api_rejects_rebinding_and_cross_origin(headers):
    with client() as api:
        assert api.get('/api/config', headers=headers).status_code == 403
        assert api.post('/api/open-local', headers=headers).status_code == 403


def test_lan_requires_pairing_cookie_and_blocks_foreign_origin():
    with client(bind_host='0.0.0.0') as api:
        assert api.get('/api/config').status_code == 401
        assert api.get('/pair/invalid', follow_redirects=False).status_code == 404
        pair = api.get(api.app.state.pairing_path, follow_redirects=False)
        assert pair.status_code == 303
        assert pair.headers['location'] == '/'
        assert pair.headers['cache-control'] == 'no-store'
        assert pair.headers['referrer-policy'] == 'no-referrer'
        cookie = pair.headers['set-cookie'].lower()
        assert 'httponly' in cookie and 'samesite=strict' in cookie
        assert api.app.state.pairing_path.split('/')[-1] not in cookie
        assert api.get('/api/config').json() == {'library': False}
        assert api.post('/api/open-local', headers={'Origin': 'http://foreign.invalid'}).status_code == 403


def test_upload_limit_applies_to_declared_and_chunked_bodies(monkeypatch):
    monkeypatch.setattr(server, 'MAX_UPLOAD_BYTES', 256)
    with client() as api:
        assert api.post('/api/import', files={'files': ('large', b'x' * 512)}).status_code == 413
        chunks = iter([b'--foo\r\nContent-Disposition: form-data; name="files"; filename="x"\r\n\r\n',
                       b'x' * 256, b'\r\n--foo--\r\n'])
        result = api.post('/api/import', content=chunks,
                          headers={'Content-Type': 'multipart/form-data; boundary=foo'})
        assert result.status_code == 413


def test_bad_forms_have_generic_errors():
    with client() as api:
        assert api.post('/api/import').status_code == 415
        malformed = api.post('/api/import', content=b'invalid', headers={
            'Content-Type': 'multipart/form-data; boundary=foo',
        })
        assert malformed.status_code == 400
        assert 'invalid' not in malformed.text


def test_cached_local_frame_cannot_follow_replaced_path(tmp_path):
    library = tmp_path / 'configured'
    library.mkdir()
    frame = library / 'frame'
    frame.write_bytes(image_bytes())
    outside = tmp_path / 'outside'
    outside.write_bytes(image_bytes())
    with client(library=library) as api:
        opened = api.post('/api/open-local').json()
        frame.unlink()
        frame.symlink_to(outside)
        result = api.get(f"/api/frame/{opened['session']}/{first_frame(opened)}")
        assert result.status_code == 422
        assert str(outside) not in result.text


def test_old_sessions_expire_when_storage_is_full(monkeypatch):
    monkeypatch.setattr(server, 'MAX_SESSIONS', 1)
    with client() as api:
        first = api.post('/api/import', files={'files': ('slice', image_bytes())}).json()
        second = api.post('/api/import', files={'files': ('slice', image_bytes())}).json()
        first_url = f"/api/frame/{first['session']}/{first_frame(first)}"
        second_url = f"/api/frame/{second['session']}/{first_frame(second)}"
        assert api.get(first_url).status_code == 404
        assert api.get(second_url).status_code == 200


def test_large_frames_negotiate_gzip_without_changing_pixels_or_dicom_headers():
    with client() as api:
        imported = api.post('/api/import', files={'files': ('slice', image_bytes(rows=4096))}).json()
        url = f"/api/frame/{imported['session']}/{first_frame(imported)}"
        identity = api.get(url, headers={'Accept-Encoding': 'identity'})
        assert identity.status_code == 200
        assert 'content-encoding' not in identity.headers
        assert len(identity.content) == 4096 * 2 * 4
        assert identity.headers['vary'].lower() == 'accept-encoding'
        with api.stream('GET', url, headers={'Accept-Encoding': 'br, gzip;q=1'}) as compressed:
            assert compressed.status_code == 200
            assert compressed.headers['content-encoding'] == 'gzip'
            assert compressed.headers['vary'].lower() == 'accept-encoding'
            assert compressed.headers['content-type'] == identity.headers['content-type']
            assert compressed.headers['cache-control'] == identity.headers['cache-control']
            fields = ('width', 'height', 'type', 'window-center', 'window-width', 'invert', 'pixel-spacing')
            for field in fields:
                assert compressed.headers[f'x-{field}'] == identity.headers[f'x-{field}']
            wire = b''.join(compressed.iter_raw())
            assert len(wire) < len(identity.content)
            assert gzip.decompress(wire) == identity.content
        disabled = api.get(url, headers={'Accept-Encoding': 'gzip;q=0, identity'})
        assert 'content-encoding' not in disabled.headers
        assert disabled.content == identity.content
        prefers_identity = api.get(url, headers={'Accept-Encoding': 'identity;q=1, gzip;q=0.5'})
        assert 'content-encoding' not in prefers_identity.headers


def test_small_frames_are_not_compressed_even_if_gzip_is_accepted():
    with client() as api:
        imported = api.post('/api/import', files={'files': ('slice', image_bytes())}).json()
        url = f"/api/frame/{imported['session']}/{first_frame(imported)}"
        small = api.get(url, headers={'Accept-Encoding': 'gzip'})
        assert small.status_code == 200
        assert 'content-encoding' not in small.headers
        assert len(small.content) == 8


def test_static_root_serves_only_web_files(tmp_path, monkeypatch):
    web = tmp_path / 'web'
    web.mkdir()
    (web / 'index.html').write_text('<h1>Viewer</h1>', encoding='utf-8')
    restricted = tmp_path / 'not-web.txt'
    restricted.write_text('must not download', encoding='utf-8')
    (web / 'escape').symlink_to(restricted)
    monkeypatch.setattr(server, 'WEB', web)
    with client() as api:
        root = api.get('/')
        assert root.text == '<h1>Viewer</h1>'
        assert "connect-src 'self'" in root.headers['content-security-policy']
        assert api.get('/escape').status_code == 404
        assert api.get('/server.py').status_code == 404


def study_id(uid):
    return hashlib.sha256(uid.encode('utf-8')).hexdigest()


def write_image(root, name, **options):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(image_bytes(**options))
    return path


def test_library_lists_six_studies_newest_first_with_stable_ids(tmp_path):
    library = tmp_path / 'configured'
    library.mkdir()
    exams = [
        (generate_uid(), '20260103', 'Exam three'),
        (generate_uid(), '20260106', 'Exam six'),
        (generate_uid(), '20260101', 'Exam one'),
        (generate_uid(), '20260105', 'Exam five'),
        (generate_uid(), '20260102', 'Exam two'),
        (generate_uid(), '20260104', 'Exam four'),
    ]
    for index, (uid, date, description) in enumerate(exams):
        write_image(library, f'dir-{index % 2}/nested-{index}/slice',
                    study=uid, date=date, description=description)

    with client(library=library) as api:
        response = api.get('/api/library/studies')
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        assert response.headers['content-type'].startswith('application/json')
        payload = response.json()
        assert set(payload) == {'studies', 'skipped'}
        assert payload['skipped'] == 0
        rows = payload['studies']
        assert len(rows) == 6
        assert [row['date'] for row in rows] == [
            '20260106', '20260105', '20260104', '20260103', '20260102', '20260101',
        ]
        assert [row['label'] for row in rows] == [
            'Exam six', 'Exam five', 'Exam four', 'Exam three', 'Exam two', 'Exam one',
        ]
        for row in rows:
            assert set(row) == {'id', 'label', 'date', 'modalities', 'seriesCount', 'frameCount'}
            assert row['modalities'] == ['CT']
            assert row['seriesCount'] == 1
            assert row['frameCount'] == 1
        assert {row['id'] for row in rows} == {study_id(uid) for uid, _, _ in exams}

        first_ids = [row['id'] for row in rows]
        second_ids = [row['id'] for row in api.get('/api/library/studies').json()['studies']]
        assert second_ids == first_ids

    with client(library=library) as api:
        again = api.get('/api/library/studies').json()['studies']
        assert [row['id'] for row in again] == first_ids


def test_library_groups_a_study_split_across_nested_directories(tmp_path):
    library = tmp_path / 'configured'
    study = generate_uid()
    first_series = generate_uid()
    second_series = generate_uid()
    other_study = generate_uid()
    write_image(library, 'deep/a/one', study=study, series=first_series, date='20260102')
    write_image(library, 'deep/b/two', study=study, series=first_series, date='20260102')
    write_image(library, 'other/three', study=study, series=second_series, date='20260102')
    write_image(library, 'unrelated', study=other_study, date='20260101')

    with client(library=library) as api:
        rows = api.get('/api/library/studies').json()['studies']
        assert len(rows) == 2
        selected = [row for row in rows if row['id'] == study_id(study)]
        assert len(selected) == 1
        assert selected[0]['date'] == '20260102'
        assert selected[0]['seriesCount'] == 2
        assert selected[0]['frameCount'] == 3
        assert [row['id'] for row in rows][-1] == study_id(other_study)


def test_library_list_does_not_create_or_evict_sessions(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'MAX_SESSIONS', 1)
    library = tmp_path / 'configured'
    library.mkdir()
    write_image(library, 'exam', study=generate_uid())
    with client(library=library) as api:
        imported = api.post('/api/import', files={'files': ('temporary', image_bytes())}).json()
        frame_url = f"/api/frame/{imported['session']}/{first_frame(imported)}"
        assert api.get(frame_url).status_code == 200
        for _ in range(3):
            response = api.get('/api/library/studies')
            assert response.status_code == 200
            assert 'session' not in response.json()
        assert api.get(frame_url).status_code == 200


def test_library_list_contains_no_patient_frame_uid_or_path_data(tmp_path):
    library = tmp_path / 'configured'
    library.mkdir()
    uid = generate_uid()
    path = write_image(library, 'private-frame-name', study=uid,
                       date='20260101', description='Visible exam')
    with client(library=library) as api:
        response = api.get('/api/library/studies')
        payload = response.json()
        assert len(payload['studies']) == 1
        row = payload['studies'][0]
        assert set(row) == {'id', 'label', 'date', 'modalities', 'seriesCount', 'frameCount'}
        assert row['id'] == study_id(uid)
        assert row['label'] == 'Visible exam'
        assert row['date'] == '20260101'
        text = response.text
        assert uid not in text
        assert 'Synthetic^Patient' not in text
        assert 'private-frame-name' not in text
        assert str(path) not in text
        assert str(library) not in text
        assert '"series"' not in text
        assert '"frames"' not in text
        assert '"patient"' not in text


def test_library_and_tags_use_legacy_charset_override(tmp_path, monkeypatch):
    library = tmp_path / 'configured'
    library.mkdir()
    study = generate_uid()
    placeholder = b'LEGACY'
    data = image_bytes(study=study, date='20260101', description=placeholder.decode('ascii'))
    assert data.count(placeholder) == 1
    raw_description = 'Привет'.encode('cp1251')
    assert len(raw_description) == len(placeholder)
    (library / 'exam').write_bytes(data.replace(placeholder, raw_description))
    monkeypatch.setenv('POCKET_DICOM_LEGACY_CHARSET', 'cp1251')

    with client(library=library) as api:
        rows = api.get('/api/library/studies').json()['studies']
        assert len(rows) == 1
        assert rows[0]['label'] == 'Привет'

        opened = api.post(f"/api/library/studies/{rows[0]['id']}/open")
        assert opened.status_code == 200
        payload = opened.json()
        assert payload['studies'][0]['label'] == 'Привет'
        assert payload['studies'][0]['details']['StudyDescription'] == 'Привет'
        tags = api.get(f"/api/tags/{payload['session']}/{first_frame(payload)}").json()['tags']
        assert tags['StudyDescription'] == 'Привет'


def test_opening_one_study_exposes_only_its_frames(tmp_path):
    library = tmp_path / 'configured'
    library.mkdir()
    first_uid = generate_uid()
    second_uid = generate_uid()
    write_image(library, 'first', study=first_uid, date='20260102',
                description='First exam')
    write_image(library, 'second', study=second_uid, date='20260101',
                description='Second exam')

    with client(library=library) as api:
        rows = api.get('/api/library/studies').json()['studies']
        by_date = {row['date']: row['id'] for row in rows}

        second = api.post(f"/api/library/studies/{by_date['20260101']}/open")
        assert second.status_code == 200
        second_payload = second.json()
        assert set(second_payload) == {'session', 'studies', 'skipped'}
        assert second_payload['studies'][0]['label'] == 'Second exam'
        assert len(second_payload['studies']) == 1
        second_frame = first_frame(second_payload)
        second_session = second_payload['session']
        assert api.get(f'/api/frame/{second_session}/{second_frame}').status_code == 200

        first = api.post(f"/api/library/studies/{by_date['20260102']}/open")
        assert first.status_code == 200
        first_payload = first.json()
        assert first_payload['studies'][0]['label'] == 'First exam'
        assert len(first_payload['studies']) == 1
        first_session = first_payload['session']
        first_frame_id = first_frame(first_payload)

        frame = api.get(f'/api/frame/{first_session}/{first_frame_id}')
        assert frame.status_code == 200
        assert np.frombuffer(frame.content, dtype='<f4').tolist() == [-120, -90]
        assert api.get(f'/api/frame/{first_session}/{second_frame}').status_code == 404
        assert api.get(f'/api/tags/{first_session}/{second_frame}').status_code == 404
        assert api.get(f'/api/frame/{second_session}/{second_frame}').status_code == 200


def test_library_routes_reject_disabled_unknown_and_unpaired_requests(tmp_path):
    unknown = '0' * 64
    with client() as api:
        assert api.get('/api/library/studies').status_code == 404
        assert api.post(f'/api/library/studies/{unknown}/open').status_code == 404

    library = tmp_path / 'configured'
    library.mkdir()
    write_image(library, 'exam', study=generate_uid())
    with client(library=library) as api:
        assert api.get('/api/library/studies').status_code == 200
        missing = api.post(f'/api/library/studies/{unknown}/open')
        assert missing.status_code == 404
        assert str(library) not in missing.text
        assert api.post('/api/library/studies/not-a-study/open').status_code == 404
        assert api.get('/api/library/studies', headers={
            'Origin': 'http://foreign.invalid',
        }).status_code == 403
        assert api.post(f'/api/library/studies/{unknown}/open', headers={
            'Host': 'example.invalid:8765',
        }).status_code == 403

    with client(bind_host='0.0.0.0', library=library) as api:
        assert api.get('/api/library/studies').status_code == 401
        assert api.post(f'/api/library/studies/{unknown}/open').status_code == 401
        pair = api.get(api.app.state.pairing_path, follow_redirects=False)
        assert pair.status_code == 303
        allowed = api.get('/api/library/studies')
        assert allowed.status_code == 200
        assert allowed.headers['cache-control'] == 'no-store'


def test_library_list_does_not_follow_links_outside_the_configured_root(tmp_path):
    library = tmp_path / 'configured'
    library.mkdir()
    inside = generate_uid()
    outside = generate_uid()
    write_image(library, 'inside', study=inside, date='20260101')
    outside_file = tmp_path / 'outside'
    outside_file.write_bytes(image_bytes(study=outside, date='20260102'))
    (library / 'escape-file').symlink_to(outside_file)
    outside_dir = tmp_path / 'outside-dir'
    outside_dir.mkdir()
    write_image(outside_dir, 'escape', study=outside, date='20260102')
    (library / 'escape-dir').symlink_to(outside_dir, target_is_directory=True)

    with client(library=library) as api:
        response = api.get('/api/library/studies')
        payload = response.json()
        assert len(payload['studies']) == 1
        assert payload['studies'][0]['id'] == study_id(inside)
        assert study_id(outside) not in response.text


def counting_builds(monkeypatch):
    real = server.build_catalog
    builds = []

    def counted(paths):
        builds.append(tuple(paths))
        return real(paths)

    monkeypatch.setattr(server, 'build_catalog', counted)
    return builds


def test_library_catalog_is_warmed_once_and_reused(tmp_path, monkeypatch):
    library = tmp_path / 'configured'
    library.mkdir()
    uid = generate_uid()
    write_image(library, 'nested/exam', study=uid)
    builds = counting_builds(monkeypatch)

    with client(library=library) as api:
        assert len(builds) == 1
        baseline = len(builds)
        rows = api.get('/api/library/studies').json()['studies']
        assert [row['id'] for row in rows] == [study_id(uid)]
        assert len(builds) == baseline

        assert api.get('/api/library/studies').json()['studies'] == rows
        assert len(builds) == baseline

        opened = api.post(f"/api/library/studies/{rows[0]['id']}/open")
        assert opened.status_code == 200
        local = api.post('/api/open-local')
        assert local.status_code == 200
        assert first_frame(opened.json()) == first_frame(local.json())
        assert len(builds) == baseline


def test_library_catalog_rebuilds_after_external_changes(tmp_path, monkeypatch):
    library = tmp_path / 'configured'
    library.mkdir()
    first_uid = generate_uid()
    second_uid = generate_uid()
    first = write_image(library, 'nested/first', study=first_uid,
                        date='20260102', description='First exam')
    second = write_image(library, 'second', study=second_uid,
                         date='20260101', description='Second exam')
    builds = counting_builds(monkeypatch)

    with client(library=library) as api:
        assert len(builds) == 1
        baseline = len(builds)
        assert len(api.get('/api/library/studies').json()['studies']) == 2
        assert len(builds) == baseline

        data = first.read_bytes()
        assert data.count(b'First exam') == 1
        first.write_bytes(data.replace(b'First exam', b'Other exam'))
        edited = api.get('/api/library/studies').json()['studies']
        assert len(builds) == baseline + 1
        assert {row['label'] for row in edited} == {'Other exam', 'Second exam'}

        third_uid = generate_uid()
        added = write_image(library, 'new/deep/third', study=third_uid,
                            date='20260103', description='Third exam')
        added_rows = api.get('/api/library/studies').json()['studies']
        assert len(builds) == baseline + 2
        assert study_id(third_uid) in {row['id'] for row in added_rows}

        added.unlink()
        removed_rows = api.get('/api/library/studies').json()['studies']
        assert len(builds) == baseline + 3
        assert study_id(third_uid) not in {row['id'] for row in removed_rows}

        first.unlink()
        first.symlink_to(second)
        linked = api.get('/api/library/studies').json()
        assert len(builds) == baseline + 4
        assert [row['id'] for row in linked['studies']] == [study_id(second_uid)]
        assert linked['skipped'] == 0

        (library / 'notes.txt').write_bytes(b'not DICOM')
        skipped = api.get('/api/library/studies').json()
        assert len(builds) == baseline + 5
        assert skipped['skipped'] == 1
        assert [row['id'] for row in skipped['studies']] == [study_id(second_uid)]


def test_library_catalog_still_enforces_bounds_after_warming(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'MAX_FILES', 1)
    library = tmp_path / 'configured'
    library.mkdir()
    write_image(library, 'one', study=generate_uid())

    with client(library=library) as api:
        assert api.get('/api/library/studies').status_code == 200
        (library / 'two').write_bytes(image_bytes())
        assert api.get('/api/library/studies').status_code == 413
        (library / 'two').unlink()
        assert api.get('/api/library/studies').status_code == 200
