"""Synthetic browser acceptance check for the saved-exam library UI.

Run it against an integrated localhost server whose --library points at a
synthetic six-study folder:

    /venv/bin/python tests/smoke_exam_library.py http://127.0.0.1:8765

Create the seed using the fixture helper. Use a separate writable directory
when checking persistent uploads:

    /venv/bin/python tests/smoke_exam_library.py --make-library /tmp/pocket-library
    mkdir /tmp/pocket-uploads
    /venv/bin/python server.py --library /tmp/pocket-library --library-store /tmp/pocket-uploads

Chromium can be selected with CHROMIUM_EXECUTABLE (aliases: PW_CHROMIUM,
CHROMIUM_PATH, PW_EXECUTABLE_PATH). If none is set, Playwright's bundled
Chromium is used. Set PW_CHANNEL=chrome to use an installed Chrome channel
instead. Set REQUIRE_LIBRARY_WRITE=1 when the server must expose a writable
library; otherwise the persistent-upload check is reported as skipped when
GET /api/config has libraryWritable=false.

Every DICOM object used here is generated in memory or in the requested
fixture folder. The browser check reads only the supplied localhost URL and
makes no external requests.
"""
import io
import os
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from pydicom import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid
from playwright.sync_api import sync_playwright

EXPECTED_STUDIES = int(os.getenv('EXPECTED_LIBRARY_STUDIES', '6'))
DATE_WORDS = re.compile(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b')


def _dicom(study, series, description, series_description, modality, index, count, date):
    uid = generate_uid()
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = uid
    ds = FileDataset(None, {}, file_meta=meta, preamble=bytes(128))
    ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, uid
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, study
    ds.PatientName, ds.PatientID = 'Synthetic^Library', 'SYNTHETIC'
    ds.StudyDescription, ds.StudyDate = description, date
    ds.Modality, ds.SeriesDescription, ds.InstanceNumber = modality, series_description, index + 1
    ds.SeriesNumber = 1
    ds.Rows = ds.Columns = 32
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
    ds.PixelSpacing, ds.ImageOrientationPatient = [1, 1], [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [0, 0, 2 * index]
    ds.WindowCenter, ds.WindowWidth = 0, 800
    y, x = np.indices((32, 32))
    ds.PixelData = np.where((x - index - 6) ** 2 + (y - 16) ** 2 < 45, 600, -400).astype('<i2').tobytes()
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return {'name': f'{series_description.replace(" ", "-")}-{index:02}.dcm',
            'mimeType': 'application/dicom', 'buffer': buf.getvalue()}


def files(description, series_count=1, frames=4, date='20240102'):
    """One synthetic study, shaped like Playwright's set_input_files payload."""
    study = generate_uid()
    items = []
    for series_index in range(series_count):
        series = generate_uid()
        for index in range(frames):
            items.append(_dicom(study, series, description, f'Synthetic series {series_index + 1}',
                                'CT', index, frames, date))
    return items


def make_library(directory):
    """Write a deterministic six-study synthetic library for local acceptance."""
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    for exam in range(EXPECTED_STUDIES):
        description = f'Synthetic library exam {exam + 1}'
        date = f'202401{exam + 1:02d}'
        study = generate_uid()
        series_count = 2 if exam == 0 else 1
        frames = 6 if exam == 0 else 4
        for series_index in range(series_count):
            series = generate_uid()
            for index in range(frames):
                item = _dicom(study, series, description, f'Synthetic series {series_index + 1}',
                              'CT', index, frames, date)
                (root / f'{exam + 1:02d}-{series_index + 1:02d}-{index + 1:02d}.dcm').write_bytes(item['buffer'])
    return root


def _launch(pw):
    options = {'headless': True, 'args': ['--enable-unsafe-swiftshader']}
    executable = (os.getenv('CHROMIUM_EXECUTABLE') or os.getenv('PW_CHROMIUM') or
                  os.getenv('CHROMIUM_PATH') or os.getenv('PW_EXECUTABLE_PATH'))
    if executable:
        options['executable_path'] = executable
    elif os.getenv('PW_CHANNEL'):
        options['channel'] = os.getenv('PW_CHANNEL')
    return pw.chromium.launch(**options)


def _page(browser, url, mobile=False):
    page = browser.new_page(viewport={'width': 390 if mobile else 1440, 'height': 844 if mobile else 900},
                            is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def restrict(route):
        parsed = urlparse(route.request.url)
        if parsed.scheme in ('http', 'https') and parsed.netloc != urlparse(url).netloc:
            external.append(route.request.url)
            route.abort()
        else:
            route.continue_()

    page.route('**/*', restrict)
    page.goto(url)
    return page, errors, external


def _library_buttons(page):
    return page.locator('.library-study')


def _labels(page):
    return [text.strip() for text in page.locator('.library-study strong').all_inner_texts()]


def open_library(page):
    page.locator('#open-library').wait_for(state='visible', timeout=30000)
    with page.expect_response(lambda response: response.url.split('?')[0].endswith('/api/library/studies') and
                              response.request.method == 'GET', timeout=30000) as opening:
        page.locator('#open-library').click()
    page.locator('#library-dialog').wait_for(state='visible', timeout=10000)
    _library_buttons(page).first.wait_for(timeout=30000)
    return opening.value.json()


def close_library(page):
    if page.locator('#library-dialog').is_visible():
        page.locator('#close-library').click()
        page.locator('#library-dialog').wait_for(state='hidden', timeout=10000)


def run(url):
    assert urlparse(url).hostname in ('127.0.0.1', 'localhost', '::1'), 'Use a localhost URL.'
    with sync_playwright() as pw:
        browser = _launch(pw)
        page, errors, external = _page(browser, url)
        page.locator('#open-library').wait_for(state='visible', timeout=30000)

        listing = open_library(page)
        buttons = _library_buttons(page)
        labels = _labels(page)
        assert len(buttons.all()) == EXPECTED_STUDIES, f'Expected {EXPECTED_STUDIES} visible studies, got {labels}'
        assert len(labels) == EXPECTED_STUDIES
        first_text = buttons.first.inner_text()
        assert 'CT' in first_text, 'Study rows must show the modality.'
        assert 'series' in first_text and 'image' in first_text, 'Study rows must show series and image counts.'
        assert DATE_WORDS.search(first_text), f'Study rows must show a readable date: {first_text!r}'
        assert isinstance(listing.get('studies'), list) and 'skipped' in listing
        assert page.evaluate("document.activeElement && document.activeElement.closest('#library-dialog') !== null"), \
            'Keyboard focus must stay inside the library dialog.'

        page.keyboard.press('Escape')
        page.locator('#library-dialog').wait_for(state='hidden', timeout=10000)
        listing = open_library(page)
        assert len(_library_buttons(page).all()) == EXPECTED_STUDIES, 'Rapid reopen must show a fresh study list.'

        chosen = _library_buttons(page).first
        chosen_label = chosen.locator('strong').inner_text().strip()
        with page.expect_response(lambda response: '/api/library/studies/' in response.url and
                                  response.url.split('?')[0].endswith('/open') and
                                  response.request.method == 'POST', timeout=120000) as opening:
            chosen.click()
        opened = opening.value.json()
        assert opening.value.ok and opened.get('session'), 'Opening a saved exam must return a viewer session.'
        page.locator('#library-dialog').wait_for(state='hidden', timeout=30000)
        page.locator('#active').wait_for(state='visible', timeout=30000)
        page.locator('#view-area canvas:visible').first.wait_for(timeout=120000)
        assert page.locator('#active-name').inner_text().strip(), 'The viewer needs an active series name.'

        page.get_by_role('button', name='Exam details', exact=True).click()
        details = page.locator('#info-dialog')
        details.wait_for(state='visible', timeout=10000)
        assert chosen_label in details.inner_text(), 'Exam details must describe the selected study.'
        page.locator('#close-info').click()

        page.locator('#open-library').click()
        page.locator('#library-dialog').wait_for(state='visible', timeout=10000)
        _library_buttons(page).first.wait_for(timeout=30000)
        assert page.locator('#library-write').is_visible() == page.evaluate(
            "fetch('/api/config').then(r=>r.json()).then(c=>c.libraryWritable===true)"), \
            'Write controls must follow the optional libraryWritable config flag.'
        active_before = page.locator('#active-name').inner_text().strip()

        writable = page.locator('#library-write').is_visible()
        expected_now = EXPECTED_STUDIES
        upload_label = None
        if writable:
            token = secrets.token_hex(4)
            upload_label = f'Synthetic upload {token}'
            payload = files(upload_label, series_count=2, frames=3, date='20240203')
            with page.expect_response(lambda response: response.url.split('?')[0].endswith('/api/library/uploads') and
                                      response.request.method == 'POST', timeout=120000) as uploaded:
                page.locator('#library-input-files').set_input_files(payload)
            result = uploaded.value.json()
            assert uploaded.value.ok and result.get('added', 0) >= 1, 'Library upload must add DICOM files.'
            assert result.get('added', 0) + result.get('skipped', 0) == len(payload)
            page.locator('.library-study', has_text=upload_label).wait_for(timeout=30000)
            assert page.locator('#active-name').inner_text().strip() == active_before, \
                'Adding library files must not replace the current viewer.'
            expected_now += 1
            print(f"Writable library: uploaded {result['added']} synthetic files; viewer retained.", flush=True)
        else:
            assert not os.getenv('REQUIRE_LIBRARY_WRITE'), 'REQUIRE_LIBRARY_WRITE=1 but libraryWritable is false.'
            assert page.locator('#library-write').is_hidden()
            print('Read-only library: persistent-upload check skipped (libraryWritable=false).', flush=True)

        close_library(page)
        if upload_label:
            page.reload()
            listing = open_library(page)
            assert upload_label in _labels(page), 'A library upload must remain visible after reload.'
            assert len(_labels(page)) == expected_now, 'A library upload must appear as one saved study.'
            close_library(page)

        temporary_label = f'Temporary import {secrets.token_hex(4)}'
        temporary = files(temporary_label, series_count=1, frames=3, date='20240304')
        with page.expect_response(lambda response: response.url.split('?')[0].endswith('/api/import') and
                                  response.request.method == 'POST', timeout=120000) as imported:
            page.locator('#input-files').set_input_files(temporary)
        assert imported.value.ok, 'The standard ephemeral import must still work.'
        page.locator('#study-list summary', has_text=temporary_label).wait_for(timeout=30000)
        page.reload()
        open_library(page)
        assert temporary_label not in _labels(page), 'Temporary imports must not be saved in the library.'
        assert len(_labels(page)) == expected_now, 'Temporary imports must not change the saved study list.'
        close_library(page)
        assert not errors, errors
        assert not external, external
        print(f'Desktop: {expected_now} saved studies; selected exam details; ephemeral import stayed out of library.',
              flush=True)
        page.close()

        mobile, mobile_errors, mobile_external = _page(browser, url, mobile=True)
        mobile.locator('#open-library').wait_for(state='visible', timeout=30000)
        assert mobile.locator('#mobile-library').is_hidden(), \
            'Library access must work without opening the mobile exam rail.'
        open_library(mobile)
        assert len(_library_buttons(mobile).all()) == expected_now
        assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        box = mobile.locator('#library-dialog').bounding_box()
        assert box and box['width'] <= 390, 'Library dialog must fit the mobile viewport.'
        close_library(mobile)
        mobile.locator('#open-library').click()
        mobile.locator('#library-dialog').wait_for(state='visible', timeout=10000)
        _library_buttons(mobile).first.wait_for(timeout=30000)
        close_library(mobile)
        assert not mobile_errors, mobile_errors
        assert not mobile_external, mobile_external
        print('Mobile 390px: library reachable from top bar, reopenable, no horizontal overflow or external requests.',
              flush=True)
        mobile.close()
        browser.close()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--make-library':
        print(f'Synthetic library written to {make_library(sys.argv[2])}.', flush=True)
    elif len(sys.argv) == 2:
        run(sys.argv[1])
    else:
        raise SystemExit(__doc__)
