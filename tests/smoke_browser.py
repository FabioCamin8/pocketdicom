"""Browser acceptance check. Uses synthetic DICOM only. Pass a running localhost URL."""
import io
import os
import re
import sys
from urllib.parse import urlparse

import numpy as np
from playwright.sync_api import sync_playwright
from pydicom import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

VOLUME_SERIES = 'Original'
SECOND_SERIES = 'Repeat'
FLAT_SERIES = 'Single-frame 2D'


def files():
    study, ref = generate_uid(), generate_uid()
    items = []
    for label, count, start in [(VOLUME_SERIES, 10, 0), (SECOND_SERIES, 10, 0.5), (FLAT_SERIES, 1, 0)]:
        series = generate_uid()
        for i in range(count):
            uid = generate_uid()
            meta = FileMetaDataset()
            meta.TransferSyntaxUID = ExplicitVRLittleEndian
            meta.MediaStorageSOPClassUID = CTImageStorage
            meta.MediaStorageSOPInstanceUID = uid
            ds = FileDataset(None, {}, file_meta=meta, preamble=bytes(128))
            ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, uid
            ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, ref
            ds.PatientName, ds.PatientID, ds.StudyDescription = 'Synthetic^Demo', 'EXAMPLE', 'Synthetic exam'
            ds.Modality, ds.SeriesDescription, ds.InstanceNumber = 'CT', label, i + 1
            ds.Rows = ds.Columns = 32
            ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
            ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
            ds.PixelSpacing, ds.ImageOrientationPatient = [1, 1], [1, 0, 0, 0, 1, 0]
            ds.ImagePositionPatient = [0, 0, start + 2 * i]
            ds.WindowCenter, ds.WindowWidth = 0, 800
            y, x = np.indices((32, 32))
            ds.PixelData = np.where((x-i-6)**2+(y-16)**2<45, 600, -400).astype('<i2').tobytes()
            buf = io.BytesIO()
            ds.save_as(buf, enforce_file_format=True)
            items.append({'name':f'{label.replace(" ", "-")}-{i:02}', 'mimeType':'application/dicom', 'buffer':buf.getvalue()})
    return items


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')


def wait_2d(page):
    page.locator('[data-view=slice][data-state=mounted] canvas:visible').first.wait_for(timeout=30000)


def resize_grips(locator):
    return locator.get_by_role('button', name=re.compile(r'Resize image viewport', re.I))


def drag_grip(page, grip, dx, dy):
    grip.scroll_into_view_if_needed()
    box = grip.bounding_box()
    assert box and box['width'] > 0 and box['height'] > 0, 'Resize grip has no layout box'
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=8)
    page.mouse.up()


def check_resize(page, scope):
    grip = resize_grips(scope).first
    canvas = scope.locator('canvas:visible').first
    before = canvas.bounding_box()
    grip.focus()
    drag_grip(page, grip, -64, -72)
    shrunk = canvas.bounding_box()
    assert all(shrunk[axis] < before[axis] - 5 for axis in ('width', 'height')), (before, shrunk)
    drag_grip(page, grip, 64, 72)
    grown = canvas.bounding_box()
    assert all(grown[axis] > shrunk[axis] + 5 for axis in ('width', 'height')), (shrunk, grown)


def canvas_boxes(locator):
    boxes=[]
    for i in range(locator.count()):
        box=locator.nth(i).bounding_box()
        assert box, 'The canvas has no layout box'
        boxes.append(box)
    return boxes


def explore_button(page):
    return page.get_by_role('button', name=re.compile(r'Explore in 3D')).first


def two_d_action(page):
    return page.get_by_role('button', name='2D slices', exact=True).first


def wait_mip(page):
    """The guided 3D entry point is a single, ready MIP canvas."""
    canvas = page.locator('canvas[aria-label^="3D"][data-render-state="ready"]').first
    canvas.wait_for(timeout=30000)
    assert page.locator('#view-area canvas:visible').count() == 1, 'Guided 3D must start with only the MIP canvas visible'
    box = canvas.bounding_box()
    assert box, '3D MIP canvas has no box'
    width, height = page.evaluate('[innerWidth, innerHeight]')
    visible_width = min(box['x'] + box['width'], width) - max(box['x'], 0)
    visible_height = min(box['y'] + box['height'], height) - max(box['y'], 0)
    assert visible_width > 1 and visible_height > 1, f'3D MIP does not intersect the first viewport: {box}, viewport {width}x{height}'
    return canvas


def pressed(page, name):
    control = page.get_by_role('button', name=re.compile(rf'^{re.escape(name)}$', re.I)).first
    control.wait_for(timeout=30000)
    value = control.get_attribute('aria-pressed')
    assert value in ('true', 'false'), f'{name} is missing aria-pressed: {value}'
    return control, value


def choose_plane(page, mobile, name):
    """Use the first visible button/tab/select that changes the displayed section plane."""
    for role in ('button', 'radio', 'tab'):
        controls = page.get_by_role(role, name=re.compile(rf'\b{re.escape(name)}\b', re.I))
        for i in range(controls.count()):
            control = controls.nth(i)
            if control.is_visible():
                (control.tap() if mobile else control.click())
                return control
    selects = page.locator('select:visible')
    for i in range(selects.count()):
        select = selects.nth(i)
        for option in select.locator('option').all_inner_texts():
            if re.search(rf'\b{re.escape(name)}\b', option, re.I):
                select.select_option(label=option)
                return select
    raise AssertionError(f'No selectable {name} section plane control was found')


def open_series(page, label, mobile):
    if mobile:
        toggle = page.locator('#mobile-library')
        if toggle.get_attribute('aria-expanded') != 'true':
            toggle.click()
    page.locator('#study-list button').filter(has_text=label).first.click()
    page.locator('#active-name').filter(has_text=label).wait_for(timeout=30000)
    wait_2d(page)


def run(url):
    assert urlparse(url).hostname in ('127.0.0.1', 'localhost', '::1')
    synthetic = files()
    with sync_playwright() as pw:
        engine=os.getenv('PW_BROWSER','chromium')
        executable=os.getenv('PW_EXECUTABLE_PATH')
        args=['--enable-unsafe-swiftshader']
        if engine=='webkit':
            browser=pw.webkit.launch(headless=True)
        elif executable:
            browser=pw.chromium.launch(executable_path=executable,headless=True,args=args)
        else:
            browser=pw.chromium.launch(channel=os.getenv('PW_CHANNEL','chrome'),headless=True,args=args)
        try:
            for mobile in (False, True):
                page = browser.new_page(viewport={'width':390 if mobile else 1440, 'height':844 if mobile else 900},
                                        is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
                errors, external = [], []
                page.on('pageerror', lambda e: errors.append(str(e)))
                def restrict(route):
                    parsed=urlparse(route.request.url)
                    if parsed.scheme in ('http','https') and parsed.netloc != urlparse(url).netloc:
                        external.append(route.request.url); route.abort()
                    else:
                        route.continue_()
                page.route('**/*', restrict)
                page.goto(url)
                page.locator('#input-files').set_input_files({'name':'not-dicom.txt','mimeType':'text/plain','buffer':b'Not a DICOM image'})
                page.locator('#import-status.error').wait_for(timeout=15000)
                assert page.locator('#welcome').is_visible()
                page.locator('#input-files').set_input_files(synthetic)
                page.locator('.slice-readout').filter(has_text='32 × 32').first.wait_for(timeout=30000)
                stage=page.locator('.slice-stage').bounding_box()
                assert stage and stage['height']>=180, f'Image viewport collapsed: {stage}'
                wait_2d(page)
                check_resize(page, page.locator('[data-view=slice]'))
                no_overflow(page)
                assert page.locator('[data-mode=slice]').get_attribute('aria-pressed')=='true', 'A compatible series must open in 2D first'
                assert explore_button(page).is_enabled(), 'A compatible series must offer Explore in 3D'
                no_overflow(page)
                page.get_by_role('button',name='Next frame',exact=True).click()
                assert page.get_by_role('slider',name='Frame',exact=True).input_value()=='2'
                page.get_by_role('combobox',name='Window preset').select_option('bone')
                assert page.get_by_role('spinbutton',name='Window center').input_value()=='300'
                page.get_by_role('button',name='Rotate clockwise').click()
                with page.expect_download() as downloaded:
                    page.get_by_role('button',name='Export PNG').click()
                assert downloaded.value.path().read_bytes()[:8]==b'\x89PNG\r\n\x1a\n'
                page.get_by_role('button',name='Exam details',exact=True).click()
                assert 'Synthetic exam' in page.locator('#info-dialog').inner_text()
                page.locator('#info-body summary').click()
                page.locator('#info-body details dl dt').first.wait_for()
                page.locator('#close-info').click()

                page.get_by_role('button',name='Compare',exact=True).click()
                page.locator('#view-area .compare-pane canvas:visible').nth(1).wait_for()
                assert page.locator('#link-slices').is_checked()
                chosen=page.locator('#compare-series option:checked').inner_text()
                assert SECOND_SERIES in chosen, f'Comparison should pick the compatible series, not {chosen!r}'
                left,right=page.locator('.compare-pane').all()
                left.get_by_role('button',name='Next frame',exact=True).click()
                indices=[p.get_by_role('slider',name='Frame',exact=True).input_value() for p in (left,right)]
                assert indices==['3','3'], f'Comparison lost the selected slice or did not link its partner: {indices}'
                panes=page.locator('.compare-pane canvas:visible')
                assert panes.count()==2, 'Comparison must show two canvases'
                for pane in (left, right):
                    check_resize(page, pane)
                indices=[p.get_by_role('slider',name='Frame',exact=True).input_value() for p in (left,right)]
                assert indices==['3','3'], f'Resizing lost the linked comparison position: {indices}'
                no_overflow(page)

                page.get_by_role('button',name='Blend',exact=True).click()
                blend_canvas=page.locator('[data-view=blend][data-state=mounted] canvas:visible').first
                blend_canvas.wait_for(timeout=30000)
                assert blend_canvas.evaluate('canvas => getComputedStyle(canvas).objectFit')=='contain', \
                    'Blend must scale its image uniformly inside the available stage'
                check_resize(page, page.locator('[data-view=blend]'))
                no_overflow(page)

                two_d_action(page).click()
                wait_2d(page)
                explore_button(page).click()
                mip=wait_mip(page)
                no_overflow(page)
                mip_image=page.locator('.pdv-rotate .pdv-image:visible').first
                ratio=mip_image.evaluate('image => { const box = image.getBoundingClientRect(); return box.width / box.height; }')
                check_resize(page, page.locator('.pdv-rotate'))
                ratio_after=mip_image.evaluate('image => { const box = image.getBoundingClientRect(); return box.width / box.height; }')
                assert abs(ratio_after - ratio) <= 0.02, f'MIP aspect changed from {ratio} to {ratio_after}'
                no_overflow(page)
                instruction=page.get_by_text(re.compile(r'Drag to rotate',re.I)).first
                instruction.wait_for(timeout=30000)
                global_2d=two_d_action(page)
                assert global_2d.is_visible() and global_2d.is_enabled(), 'The global 2D action must stay reachable from guided 3D'
                rotate,rotate_pressed=pressed(page,'Rotate volume')
                sections,sections_pressed=pressed(page,'Explore sections')
                assert (rotate_pressed,sections_pressed)==('true','false'), 'Guided 3D must start in the rotate/MIP state'

                if mobile:
                    # Touch users enter sections through an actual tap, not a synthetic click.
                    sections.tap()
                else:
                    box=mip.bounding_box()
                    assert box
                    page.mouse.move(box['x']+box['width']*0.45,box['y']+box['height']*0.45)
                    page.mouse.down()
                    page.mouse.move(box['x']+box['width']*0.62,box['y']+box['height']*0.52,steps=8)
                    page.mouse.up()
                    page.locator('canvas[aria-label^="3D"][data-render-state="ready"]').first.wait_for(timeout=30000)
                    assert instruction.is_visible(), 'Drag to rotate instruction must persist after the mouse drag'
                    sections.click()

                assert pressed(page,'Rotate volume')[1]=='false' and pressed(page,'Explore sections')[1]=='true', \
                    'Section mode must update both aria-pressed states'
                if mobile:
                    page.locator('#view-area canvas:visible').first.wait_for(timeout=30000)
                    assert page.locator('#view-area canvas:visible').count()==1, 'Mobile sections must show one canvas at a time'
                    choose_plane(page,mobile,'Coronal')
                    page.locator('#view-area canvas:visible').first.wait_for(timeout=30000)
                    assert page.locator('#view-area canvas:visible').count()==1, 'Selecting a plane must keep the single mobile canvas'
                else:
                    page.locator('#view-area canvas:visible').nth(2).wait_for(timeout=30000)
                    assert page.locator('#view-area canvas:visible').count()==3, 'Desktop sections must show three linked canvases'
                    for plane in ('Axial','Coronal','Sagittal'):
                        page.locator(f'canvas[aria-label^="{plane}"]').first.wait_for(timeout=30000)
                for panel in page.locator('.pdv-plane:visible').all():
                    check_resize(page, panel)
                no_overflow(page)

                (global_2d.tap() if mobile else global_2d.click())
                wait_2d(page)
                assert page.locator('#view-area canvas:visible').count()==1, 'Leaving 3D must show the 2D slice canvas'
                no_overflow(page)

                open_series(page,FLAT_SERIES,mobile)
                flat_explore=explore_button(page)
                flat_explore.wait_for(timeout=30000)
                assert flat_explore.is_disabled(), 'A one-frame series must not offer guided 3D'
                page.get_by_text(re.compile(r'single image',re.I)).first.wait_for(timeout=30000)
                assert page.get_by_role('slider',name='Frame',exact=True).get_attribute('max')=='1'
                page.get_by_role('combobox',name='Window preset').select_option('bone')
                assert page.get_by_role('spinbutton',name='Window center').input_value()=='300'
                wait_2d(page)
                no_overflow(page)

                assert not errors, errors
                assert not external, external
                print(engine+' '+('mobile 390px' if mobile else 'desktop 1440px') +
                      f': rejected invalid file; imported {len(synthetic)} files; 2D, details, linked comparison, blend, guided 3D MIP, '
                      + ('touch sections' if mobile else 'mouse drag and three sections')
                      + ', return to 2D, and 2D-only fallback; no external requests or JS errors.')
                page.close()
        finally:
            browser.close()


if __name__ == '__main__':
    run(sys.argv[1])
