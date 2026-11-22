import os
from pathlib import Path

import pytest
from pydicom.uid import generate_uid

import dicom_catalog
import server
from test_server import client, counting_builds, first_frame, image_bytes


def upload(api, *files):
    return api.post('/api/library/uploads',
                    files=[('files', (name, data)) for name, data in files])


def studies(api):
    response = api.get('/api/library/studies')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    return response.json()


def frames(payload):
    return [frame for study in payload['studies']
            for series in study['series'] for frame in series['frames']]


def snapshot(root):
    root = Path(root)
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob('*') if path.is_file()}


def test_store_is_opt_in_and_separate_from_the_read_only_seed(tmp_path):
    seed = tmp_path / 'seed'
    seed.mkdir()
    store = tmp_path / 'store'
    store.mkdir()

    with client() as api:
        assert api.get('/api/config').json() == {'library': False}
        assert api.get('/api/library/studies').status_code == 404
        assert upload(api, ('slice.dcm', image_bytes())).status_code == 404
        assert api.post('/api/library/studies/missing/open').status_code == 404

    with client(library=seed) as api:
        assert api.get('/api/config').json() == {'library': True}
        assert studies(api) == {'studies': [], 'skipped': 0}
        assert upload(api, ('slice.dcm', image_bytes())).status_code == 404

    with client(library_store=store) as api:
        assert api.get('/api/config').json() == {
            'library': True, 'libraryWritable': True,
        }
        assert studies(api) == {'studies': [], 'skipped': 0}

    with client(library=seed, library_store=store) as api:
        assert api.get('/api/config').json() == {
            'library': True, 'libraryWritable': True,
        }


def test_store_must_be_an_existing_directory_and_disjoint_from_the_seed(tmp_path):
    seed = tmp_path / 'seed'
    seed.mkdir()
    nested = seed / 'nested'
    nested.mkdir()
    regular_file = tmp_path / 'file'
    regular_file.write_bytes(b'not a directory')

    for options in (
        {'library_store': tmp_path / 'missing'},
        {'library_store': regular_file},
        {'library': seed, 'library_store': seed},
        {'library': seed, 'library_store': nested},
        {'library': nested, 'library_store': seed},
    ):
        with pytest.raises((OSError, ValueError)):
            server.create_app(**options)

    readonly = tmp_path / 'readonly'
    readonly.mkdir()
    readonly.chmod(0o500)
    try:
        if not os.access(readonly, os.W_OK):
            with pytest.raises((OSError, ValueError)):
                server.create_app(library_store=readonly)
    finally:
        readonly.chmod(0o700)


def test_upload_persists_images_and_stable_study_ids_across_independent_apps(tmp_path):
    store = tmp_path / 'store'
    store.mkdir()
    data = image_bytes()

    with client(library_store=store) as api:
        response = upload(api, ('slice.dcm', data))
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        assert response.json() == {'added': 1, 'skipped': 0}

        listing = studies(api)
        assert listing['skipped'] == 0
        assert len(listing['studies']) == 1
        row = listing['studies'][0]
        assert set(row) == {
            'id', 'label', 'date', 'modalities', 'seriesCount', 'frameCount',
        }
        assert row['label'] == 'Synthetic scan'
        assert row['date'] == '20261104'
        assert row['modalities'] == ['CT']
        assert row['seriesCount'] == 1
        assert row['frameCount'] == 1
        assert row['id']

        opened = api.post(f"/api/library/studies/{row['id']}/open")
        assert opened.status_code == 200
        payload = opened.json()
        assert payload['session']
        image = api.get(f"/api/frame/{payload['session']}/{first_frame(payload)}")
        assert image.status_code == 200
        stored_pixels = image.content
        study_id = row['id']

    with client(library_store=store) as api:
        assert studies(api)['studies'] == [row]

        opened = api.post(f"/api/library/studies/{study_id}/open")
        assert opened.status_code == 200
        payload = opened.json()
        image = api.get(f"/api/frame/{payload['session']}/{first_frame(payload)}")
        assert image.status_code == 200
        assert image.content == stored_pixels


def test_open_merges_seed_and_store_frames_for_the_same_study(tmp_path):
    study = generate_uid()
    seed = tmp_path / 'seed'
    seed.mkdir()
    store = tmp_path / 'store'
    store.mkdir()
    (seed / 'seed-slice').write_bytes(
        image_bytes(study=study, series=generate_uid(), rows=2))
    seed_before = snapshot(seed)

    with client(library=seed, library_store=store) as api:
        added = upload(api, ('stored-slice', image_bytes(
            study=study, series=generate_uid(), rows=3)))
        assert added.status_code == 200
        assert added.json() == {'added': 1, 'skipped': 0}

        listing = studies(api)
        assert listing['skipped'] == 0
        assert len(listing['studies']) == 1
        row = listing['studies'][0]
        assert row['modalities'] == ['CT']
        assert row['seriesCount'] == 2
        assert row['frameCount'] == 2

        opened = api.post(f"/api/library/studies/{row['id']}/open")
        assert opened.status_code == 200
        payload = opened.json()
        heights = set()
        for frame in frames(payload):
            image = api.get(f"/api/frame/{payload['session']}/{frame['id']}")
            assert image.status_code == 200
            heights.add(image.headers['x-height'])
        assert heights == {'2', '3'}

    assert snapshot(seed) == seed_before


def test_invalid_upload_returns_422_without_leaving_state(tmp_path):
    store = tmp_path / 'store'
    store.mkdir()

    with client(library_store=store) as api:
        before = snapshot(store)
        response = upload(api, ('broken.dcm', b'not a DICOM file'))
        assert response.status_code == 422
        assert response.headers['cache-control'] == 'no-store'
        assert snapshot(store) == before
        assert studies(api) == {'studies': [], 'skipped': 0}

        accepted = upload(api, ('slice.dcm', image_bytes()))
        assert accepted.status_code == 200
        assert accepted.json() == {'added': 1, 'skipped': 0}


def test_upload_reports_source_file_counts_for_partial_acceptance(tmp_path):
    store = tmp_path / 'store'
    store.mkdir()

    with client(library_store=store) as api:
        response = upload(
            api,
            ('valid', image_bytes()),
            ('DICOMDIR', image_bytes()),
            ('notes.txt', b'not DICOM'),
        )
        assert response.status_code == 200
        assert response.json() == {'added': 1, 'skipped': 2}

        listing = studies(api)
        assert listing['skipped'] == 0
        assert len(listing['studies']) == 1
        assert listing['studies'][0]['frameCount'] == 1


def test_repeated_sop_upload_is_a_noop_and_does_not_grow_the_store(tmp_path):
    store = tmp_path / 'store'
    store.mkdir()
    data = image_bytes()

    with client(library_store=store) as api:
        first = upload(api, ('first.dcm', data))
        assert first.status_code == 200
        assert first.json() == {'added': 1, 'skipped': 0}
        before = snapshot(store)

        repeated = upload(api, ('second-name.dcm', data))
        assert repeated.status_code == 200
        assert repeated.json()['added'] == 0
        assert snapshot(store) == before

        row = studies(api)['studies'][0]
        assert row['frameCount'] == 1


def test_total_byte_quota_limits_uploads_and_cleans_rejected_files(
        tmp_path, monkeypatch):
    store = tmp_path / 'store'
    store.mkdir()
    first = image_bytes(study=generate_uid(), series=generate_uid())
    second = image_bytes(study=generate_uid(), series=generate_uid())
    quota = len(first) + len(second) - 1
    monkeypatch.setattr(server, 'MAX_STORED_BYTES', quota)

    with client(library_store=store) as api:
        rejected = upload(api, ('first.dcm', first), ('second.dcm', second))
        assert rejected.status_code == 413
        assert not list(store.iterdir())
        assert studies(api) == {'studies': [], 'skipped': 0}

        chosen, excess = (first, second) if len(first) == quota else (second, first)
        assert upload(api, ('chosen.dcm', chosen)).json() == {'added': 1, 'skipped': 0}
        before = snapshot(store)
        assert upload(api, ('excess.dcm', excess)).status_code == 413
        assert snapshot(store) == before


def test_path_count_cap_uses_the_catalog_limit(tmp_path, monkeypatch):
    store = tmp_path / 'store'
    store.mkdir()
    monkeypatch.setattr(dicom_catalog, 'MAX_PATHS', 1)
    first = image_bytes()
    second = image_bytes()

    with client(library_store=store) as api:
        assert upload(api, ('first.dcm', first), ('second.dcm', second)).status_code == 413
        assert not list(store.iterdir())

        assert upload(api, ('first.dcm', first)).json() == {'added': 1, 'skipped': 0}
        before = snapshot(store)
        assert upload(api, ('second.dcm', second)).status_code == 413
        assert upload(api, ('duplicate.dcm', first)).json() == {'added': 0, 'skipped': 1}
        assert snapshot(store) == before
        assert studies(api)['studies'][0]['frameCount'] == 1


def test_store_endpoints_stay_behind_pairing_on_a_lan_address(tmp_path):
    store = tmp_path / 'store'
    store.mkdir()

    with client(library_store=store, bind_host='0.0.0.0') as api:
        assert api.get('/api/config').status_code == 401
        assert api.get('/api/library/studies').status_code == 401
        assert upload(api, ('slice.dcm', image_bytes())).status_code == 401

        pair = api.get(api.app.state.pairing_path, follow_redirects=False)
        assert pair.status_code == 303
        assert api.get('/api/library/studies').status_code == 200
        assert upload(api, ('slice.dcm', image_bytes())).json() == {
            'added': 1, 'skipped': 0,
        }


def test_lan_library_without_pairing_is_shared(tmp_path):
    options = dict(library_store=tmp_path, bind_host='0.0.0.0', no_pairing=True)
    with client(**options) as uploader, client(**options) as reader:
        assert uploader.app.state.pairing_path is None
        assert uploader.get('/pair/old-link').status_code == 404
        assert uploader.get('/api/config').json() == {'library': True, 'libraryWritable': True}
        assert uploader.post('/api/library/uploads', headers={'Origin': 'http://other.test'},
                             files={'files': ('slice.dcm', image_bytes())}).status_code == 403
        assert upload(uploader, ('slice.dcm', image_bytes())).json() == {'added': 1, 'skipped': 0}
        study, = studies(reader)['studies']
        opened = reader.post(f"/api/library/studies/{study['id']}/open")
        assert opened.status_code == 200
        payload = opened.json()
        assert reader.get(f"/api/frame/{payload['session']}/{first_frame(payload)}").status_code == 200
        assert not uploader.cookies and not reader.cookies


def test_legacy_import_stays_ephemeral_and_does_not_create_a_library(tmp_path):
    seed = tmp_path / 'seed'
    seed.mkdir()
    seed_before = snapshot(seed)
    data = image_bytes()

    with client(library=seed) as api:
        assert api.get('/api/config').json() == {'library': True}
        imported = api.post('/api/import',
                            files=[('files', ('slice', data))]).json()
        assert first_frame(imported)
        frame_id = first_frame(imported)
        url = f"/api/frame/{imported['session']}/{frame_id}"
        assert api.get(url).status_code == 200
        assert upload(api, ('slice.dcm', data)).status_code == 404

    with client(library=seed) as api:
        assert api.get('/api/config').json() == {'library': True}
        assert studies(api) == {'studies': [], 'skipped': 0}
        assert api.post('/api/open-local').json()['studies'] == []
        assert api.get(url).status_code == 404
        assert snapshot(seed) == seed_before


def test_successful_upload_rebuilds_catalog_once_and_reuses_it(tmp_path, monkeypatch):
    store = tmp_path / 'store'
    store.mkdir()
    builds = counting_builds(monkeypatch)

    with client(library_store=store) as api:
        assert len(builds) == 1
        assert studies(api) == {'studies': [], 'skipped': 0}
        assert len(builds) == 1

        accepted = upload(api, ('slice.dcm', image_bytes()))
        assert accepted.json() == {'added': 1, 'skipped': 0}
        baseline = len(builds)
        listing = studies(api)
        assert len(listing['studies']) == 1
        assert len(builds) == baseline + 1
        assert studies(api) == listing
        assert len(builds) == baseline + 1
