"""Local-only DICOM viewer server with optional LAN pairing."""

import argparse
import gzip
import hashlib
import ipaddress
import logging
import os
import re
import secrets
import shutil
import stat
import tempfile
import warnings
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

import anyio
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from python_multipart.exceptions import FormParserError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.staticfiles import StaticFiles

import dicom_catalog
from dicom_catalog import Frame, build_catalog
from dicom_overlays import read_overlays
from dicom_pixels import encode_frame


WEB = Path(__file__).resolve().parent / 'web'
MAX_UPLOAD_BYTES = 1024**3
MAX_FILE_BYTES = 512 * 1024**2
MAX_STORED_BYTES = 2 * 1024**3
MAX_FILES = 4096
MAX_SESSIONS = 4
MIN_GZIP_BYTES = 4 * 1024
PAIR_COOKIE = 'pocket_dicom_pair'
CSP = ("default-src 'self'; connect-src 'self'; script-src 'self'; "
       "img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
       "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")


class UploadParser(MultiPartParser):
    spool_max_size = 32 * 1024


@dataclass
class Session:
    frames: dict[str, Frame]
    roots: tuple[Path, ...]
    storage: tempfile.TemporaryDirectory | None = None
    size: int = 0


class Sessions:
    def __init__(self):
        self.items: OrderedDict[str, Session] = OrderedDict()
        self.lock = Lock()

    def put(self, session: Session):
        key = secrets.token_urlsafe(24)
        with self.lock:
            self.items[key] = session
            while (len(self.items) > MAX_SESSIONS or
                   sum(item.size for item in self.items.values()) > MAX_STORED_BYTES):
                # In-flight readers keep a reference to their temporary directory.
                self.items.popitem(last=False)
        return key

    def get(self, key):
        with self.lock:
            item = self.items.get(key)
            if item is not None:
                self.items.move_to_end(key)
            return item

    def close(self):
        with self.lock:
            self.items.clear()


def bound_address(host):
    return ipaddress.ip_address('127.0.0.1' if host == 'localhost' else host)


def allowed_host(value, address, port):
    match = re.fullmatch(r'(\[[0-9a-f:.]+\]|[a-z0-9.]+)(?::([0-9]{1,5}))?', value.lower())
    if not match or int(match[2] or 80) != port:
        return False
    host = match[1]
    if host == 'localhost':
        return address.is_loopback or address.is_unspecified
    if host.startswith('[') and ':' not in host:
        return False
    try:
        requested = ipaddress.ip_address(host.strip('[]'))
    except ValueError:
        return False
    if address.is_loopback:
        return requested.is_loopback
    if address.is_unspecified:
        return requested.is_private or requested.is_link_local
    return requested == address


def is_dicomdir(name):
    return name.replace('\\', '/').rsplit('/', 1)[-1].upper() == 'DICOMDIR'


def accepts_gzip(accept_encoding):
    weights = {'gzip': 0.0, 'identity': 0.0}
    for item in accept_encoding.lower().split(','):
        coding, separator, parameter = item.partition(';')
        coding = coding.strip()
        if coding not in weights:
            continue
        weight = 1.0
        if separator:
            key, equals, value = parameter.partition('=')
            if not equals or key.strip() != 'q':
                continue
            try:
                weight = float(value)
            except ValueError:
                continue
        if 0 <= weight <= 1:
            weights[coding] = weight
    return weights['gzip'] > 0 and weights['gzip'] >= weights['identity']


def scan_library(root, fingerprint=None):
    if not root.is_dir():
        raise HTTPException(404, 'Configured library is unavailable.')
    paths = []
    seen = skipped = 0
    for count, (base, dirs, names) in enumerate(os.walk(root, followlinks=False), 1):
        # Uploads are staged here before their atomic move into the committed store.
        dirs[:] = [name for name in dirs if not name.startswith('.pending-')]
        seen += len(names)
        if count > MAX_FILES or seen > MAX_FILES:
            raise HTTPException(413, 'Configured library has too many files.')
        dirs.sort()
        for name in sorted(names):
            path = Path(base) / name
            try:
                if path.is_symlink():
                    if fingerprint is not None:
                        fingerprint.append((str(path),))
                    continue
                info = path.stat()
                if fingerprint is not None:
                    fingerprint.append((str(path), info.st_size, info.st_mtime_ns,
                                        info.st_ctime_ns, info.st_ino, info.st_dev))
                if not stat.S_ISREG(info.st_mode):
                    continue
                if (is_dicomdir(name) or info.st_size > MAX_FILE_BYTES or
                        not path.resolve(strict=True).is_relative_to(root)):
                    skipped += 1
                    continue
                paths.append(path)
            except (OSError, RuntimeError):
                if fingerprint is not None:
                    fingerprint.append((str(path), None))
                skipped += 1
    return paths, skipped


def library_roots(seed, store):
    return tuple(root for root in (seed, store) if root is not None)


def scan_libraries(roots, fingerprint=None):
    candidates = []
    skipped = 0
    for root in roots:
        found, ignored = scan_library(root, fingerprint)
        candidates.extend(found)
        skipped += ignored
    return candidates, skipped


def load_catalog(roots, cache=None):
    if cache is not None:
        return cache.get()
    candidates, ignored = scan_libraries(roots)
    studies, frames, skipped = build_catalog(candidates)
    return studies, frames, skipped + ignored


class CatalogCache:
    """One app's metadata catalog, rebuilt when a cheap stat fingerprint changes."""

    def __init__(self, roots):
        self.roots = roots
        self._fingerprint = None
        self._value = None

    def get(self):
        fingerprint = []
        candidates, ignored = scan_libraries(self.roots, fingerprint)
        fingerprint = tuple(fingerprint)
        if self._value is None or fingerprint != self._fingerprint:
            studies, frames, skipped = build_catalog(candidates)
            self._value = studies, frames, skipped + ignored
            self._fingerprint = fingerprint
        return self._value

    def clear(self):
        self._fingerprint = None
        self._value = None


def open_library(roots, sessions, cache=None):
    studies, frames, skipped = load_catalog(roots, cache)
    key = sessions.put(Session(frames, tuple(roots)))
    return {'session': key, 'studies': studies, 'skipped': skipped}


def study_key(uid):
    return hashlib.sha256(uid.encode('utf-8')).hexdigest()


def study_selection(study, frames):
    """Select one catalog study's frames and derive its stable identity."""
    selected = {}
    modalities = set()
    series_count = 0
    for series in study.get('series', ()):
        series_count += 1
        modality = series.get('modality')
        if modality:
            modalities.add(modality)
        for record in series.get('frames', ()):
            frame_id = record.get('id')
            frame = frames.get(frame_id) if frame_id is not None else None
            if frame is not None:
                selected[frame_id] = frame
    uid = next(
        (frame.tags.get('StudyInstanceUID') for frame in selected.values()
         if frame.tags.get('StudyInstanceUID')),
        None,
    )
    return uid, selected, modalities, series_count


def list_library_studies(roots, cache=None):
    studies, frames, skipped = load_catalog(roots, cache)
    rows = []
    for study in studies:
        uid, selected, modalities, series_count = study_selection(study, frames)
        if uid is None or not selected:
            continue
        rows.append({
            'id': study_key(uid),
            'label': study.get('label') or 'Study',
            'date': study.get('date') or '',
            'modalities': sorted(modalities),
            'seriesCount': series_count,
            'frameCount': len(selected),
        })
    rows.sort(key=lambda row: row['id'])
    rows.sort(key=lambda row: row['date'], reverse=True)
    return rows, skipped


def open_library_study(roots, target, sessions, cache=None):
    studies, frames, skipped = load_catalog(roots, cache)
    for study in studies:
        uid, selected, _, _ = study_selection(study, frames)
        if uid is not None and selected and study_key(uid) == target:
            key = sessions.put(Session(selected, tuple(roots)))
            return {'session': key, 'studies': [study], 'skipped': skipped}
    raise HTTPException(404, 'Study not found in the configured library.')


def copy_upload(file, path):
    with path.open('wb') as dst:
        shutil.copyfileobj(file.file, dst)


def import_uploads(uploads, sessions):
    storage = tempfile.TemporaryDirectory(prefix='pocket-dicom-')
    try:
        root = Path(storage.name).resolve()
        candidates = {}
        for index, file in enumerate(uploads):
            if is_dicomdir(file.filename or '') or not file.size or file.size > MAX_FILE_BYTES:
                continue
            path = root / str(index)
            copy_upload(file, path)
            candidates[path] = file.size
        studies, frames, skipped = build_catalog(candidates)
        accepted = {frame.path for frame in frames.values()}
        for path in candidates.keys() - accepted:
            path.unlink()
        size = sum(candidates[path] for path in accepted)
        key = sessions.put(Session(frames, (root,), storage, size))
        return {'session': key, 'studies': studies, 'skipped': skipped + len(uploads) - len(candidates)}
    except BaseException:
        storage.cleanup()
        raise


def store_size(root):
    """Bytes held by committed files, excluding in-flight upload batches."""
    total = 0
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not name.startswith('.pending-')]
        for name in names:
            path = Path(base) / name
            try:
                if path.is_symlink():
                    continue
                info = path.stat()
                if stat.S_ISREG(info.st_mode):
                    total += info.st_size
            except OSError:
                continue
    return total


def store_uploads(uploads, seed, store, cache=None):
    """Validate a batch in a hidden directory and commit only its useful files."""
    pending = Path(tempfile.mkdtemp(prefix='.pending-', dir=store))
    committed = False
    try:
        staged = []
        copied_bytes = 0
        for index, file in enumerate(uploads):
            if is_dicomdir(file.filename or '') or not file.size or file.size > MAX_FILE_BYTES:
                continue
            path = pending / f'{index:06d}'
            copy_upload(file, path)
            size = path.stat().st_size
            if not size or size > MAX_FILE_BYTES:
                path.unlink()
                continue
            copied_bytes += size
            staged.append((path, size))
        if copied_bytes > MAX_UPLOAD_BYTES:
            raise HTTPException(413, 'Upload exceeds the size limit.')
        if not staged:
            raise HTTPException(422, 'No valid DICOM files were found.')

        existing, _ = scan_libraries(library_roots(seed, store))

        # Read each staged file independently to distinguish bad input from duplicate SOPs.
        valid = {}
        for path, size in staged:
            _, frames, _ = build_catalog([path])
            if frames:
                uid = next(iter(frames.values())).tags['SOPInstanceUID']
                valid[path] = (size, uid)
        if not valid:
            raise HTTPException(422, 'No valid DICOM files were found.')

        if len(existing) + len(valid) > dicom_catalog.MAX_PATHS:
            _, current_frames, _ = build_catalog(existing)
            current_sops = {frame.tags['SOPInstanceUID'] for frame in current_frames.values()}
            valid = {path: (size, uid) for path, (size, uid) in valid.items()
                     if uid not in current_sops}
            if len(existing) + len(valid) > dicom_catalog.MAX_PATHS and valid:
                raise HTTPException(413, 'The library has reached its file limit.')

        _, frames, _ = build_catalog(existing + list(valid))
        accepted = {frame.path for frame in frames.values() if frame.path in valid}
        if not accepted:
            return {'added': 0, 'skipped': len(uploads)}
        added_bytes = sum(valid[path][0] for path in accepted)
        if store_size(store) + added_bytes > MAX_STORED_BYTES:
            raise HTTPException(413, 'The library has reached its storage limit.')

        for path, _ in staged:
            if path not in accepted:
                path.unlink()

        while True:
            name = f'batch-{secrets.token_hex(16)}'
            target = store / name
            if not target.exists():
                break
        pending.rename(target)
        committed = True
        if cache is not None:
            cache.clear()
        return {'added': len(accepted), 'skipped': len(uploads) - len(accepted)}
    finally:
        if not committed:
            shutil.rmtree(pending, ignore_errors=True)


async def upload_stream(request):
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_UPLOAD_BYTES:
            raise HTTPException(413, 'Upload exceeds the size limit.')
        yield chunk


async def parse_multipart(request):
    content_type = request.headers.get('content-type', '').partition(';')[0].strip().lower()
    if content_type != 'multipart/form-data':
        raise HTTPException(415, 'Use multipart form field "files".')
    try:
        length = int(request.headers.get('content-length', '0'))
    except ValueError:
        raise HTTPException(400, 'Malformed multipart upload.') from None
    if length > MAX_UPLOAD_BYTES:
        raise HTTPException(413, 'Upload exceeds the size limit.')
    try:
        parser = UploadParser(request.headers, upload_stream(request), max_files=MAX_FILES,
                              max_fields=0, max_part_size=4096)
        return await parser.parse()
    except (ClientDisconnect, MultiPartException, FormParserError):
        raise HTTPException(400, 'Malformed multipart upload.') from None


def form_uploads(form):
    uploads = [part for part in form.getlist('files') if isinstance(part, UploadFile)]
    if not uploads:
        raise HTTPException(400, 'No files were submitted.')
    return uploads


def create_app(library=None, bind_host='127.0.0.1', port=8765, library_store=None, *, no_pairing=False):
    address = bound_address(bind_host)
    root = Path(library).expanduser().resolve(strict=True) if library is not None else None
    if root is not None and not root.is_dir():
        raise ValueError('The configured library must be a directory.')
    store = Path(library_store).expanduser().resolve(strict=True) if library_store is not None else None
    if store is not None:
        if (not store.is_dir() or not os.access(store, os.W_OK | os.X_OK) or
                not stat.S_IMODE(store.stat().st_mode) & 0o222):
            raise ValueError('The configured library store must be a writable directory.')
        if root is not None and (
                root == store or root.is_relative_to(store) or store.is_relative_to(root)):
            raise ValueError('The configured library and store must be separate directories.')
    roots = library_roots(root, store)
    sessions = Sessions()
    catalog_cache = CatalogCache(roots)
    # Keep one import and at most two on-demand pixel decodes active at a time.
    imports = anyio.Semaphore(1)
    decodes = anyio.CapacityLimiter(2)
    pairing_key = None if no_pairing or address.is_loopback else secrets.token_urlsafe(32)
    cookie = secrets.token_urlsafe(32) if pairing_key else None

    @asynccontextmanager
    async def lifespan(_app):
        # Warm the first click while keeping an unavailable library non-fatal.
        if roots:
            try:
                async with imports:
                    await anyio.to_thread.run_sync(catalog_cache.get)
            except Exception:
                pass
        try:
            yield
        finally:
            sessions.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan,
                  redirect_slashes=False)
    app.state.pairing_path = f'/pair/{pairing_key}' if pairing_key else None

    @app.middleware('http')
    async def privacy(request, call_next):
        hosts = request.headers.getlist('host')
        origins = request.headers.getlist('origin')
        path = request.scope['path']
        api = path == '/api' or path.startswith('/api/')
        same_host = len(hosts) == 1 and allowed_host(hosts[0], address, port)
        same_origin = not origins or (len(origins) == 1 and same_host and
                                      origins[0].lower() == f'http://{hosts[0].lower()}')
        local_fetch = request.headers.get('sec-fetch-site', 'none') in ('same-origin', 'none')
        if not same_host or not same_origin or (api and not local_fetch):
            response = JSONResponse({'detail': 'Host or origin is not allowed.'}, status_code=403)
        elif cookie and api and not secrets.compare_digest(
                request.cookies.get(PAIR_COOKIE, '').encode('utf-8'), cookie.encode('ascii')):
            response = JSONResponse({'detail': 'Open the pairing link printed by the server.'}, status_code=401)
        else:
            response = await call_next(request)
        response.headers['Content-Security-Policy'] = CSP
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        if api or path.startswith('/pair/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.get('/pair/{token}')
    def pair(token: str):
        if not pairing_key or not secrets.compare_digest(token.encode('utf-8'), pairing_key.encode('ascii')):
            raise HTTPException(404, 'Pairing link not found.')
        response = RedirectResponse('/', 303)
        response.set_cookie(PAIR_COOKIE, cookie, httponly=True, samesite='strict')
        return response

    @app.get('/api/config')
    def config():
        if store is None:
            return {'library': root is not None}
        return {'library': True, 'libraryWritable': True}

    @app.post('/api/open-local')
    async def local():
        if not roots:
            raise HTTPException(404, 'No library is configured.')
        async with imports:
            try:
                return await anyio.to_thread.run_sync(open_library, roots, sessions, catalog_cache)
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(422, 'Could not open the configured library.') from None

    @app.get('/api/library/studies')
    async def library_studies():
        if not roots:
            raise HTTPException(404, 'No library is configured.')
        async with imports:
            try:
                studies, skipped = await anyio.to_thread.run_sync(list_library_studies, roots,
                                                                   catalog_cache)
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(422, 'Could not read the configured library.') from None
        return {'studies': studies, 'skipped': skipped}

    @app.post('/api/library/studies/{study_id}/open')
    async def library_study(study_id: str):
        if not roots:
            raise HTTPException(404, 'No library is configured.')
        async with imports:
            try:
                return await anyio.to_thread.run_sync(open_library_study, roots, study_id,
                                                      sessions, catalog_cache)
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(422, 'Could not open the selected study.') from None

    @app.post('/api/import')
    async def upload(request: Request):
        async with imports:
            form = await parse_multipart(request)
            try:
                uploads = form_uploads(form)
                try:
                    return await anyio.to_thread.run_sync(import_uploads, uploads, sessions)
                except HTTPException:
                    raise
                except Exception:
                    raise HTTPException(422, 'Could not import the uploaded files.') from None
            finally:
                await form.close()

    @app.post('/api/library/uploads')
    async def library_upload(request: Request):
        if store is None:
            raise HTTPException(404, 'No writable library is configured.')
        async with imports:
            form = await parse_multipart(request)
            try:
                uploads = form_uploads(form)
                try:
                    return await anyio.to_thread.run_sync(store_uploads, uploads, root, store,
                                                          catalog_cache)
                except HTTPException:
                    raise
                except Exception:
                    raise HTTPException(422, 'Could not store the uploaded files.') from None
            finally:
                await form.close()

    def item_and_frame(session, frame_id):
        item = sessions.get(session)
        frame = item.frames.get(frame_id) if item else None
        if frame is None:
            raise HTTPException(404, 'Frame or session not found.')
        return item, frame

    def from_frame(session, frame_id, reader):
        item, frame = item_and_frame(session, frame_id)
        try:
            resolved = frame.path.resolve(strict=True)
            if (frame.path.is_symlink() or
                    not any(resolved.is_relative_to(root) for root in item.roots)):
                raise OSError
            return reader(frame.path, frame.index)
        except Exception:
            raise HTTPException(422, 'Could not read the selected frame.') from None

    def frame_payload(session, frame_id, compress):
        data, headers = from_frame(session, frame_id, encode_frame)
        headers['Vary'] = 'Accept-Encoding'
        if compress and len(data) >= MIN_GZIP_BYTES:
            encoded = gzip.compress(data, compresslevel=1, mtime=0)
            if len(encoded) < len(data):
                data = encoded
                headers['Content-Encoding'] = 'gzip'
        return data, headers

    @app.get('/api/frame/{session}/{frame_id}')
    async def image(session: str, frame_id: str, request: Request):
        compress = accepts_gzip(','.join(request.headers.getlist('accept-encoding')))
        data, headers = await anyio.to_thread.run_sync(frame_payload, session, frame_id, compress,
                                                        limiter=decodes)
        return Response(data, media_type='application/octet-stream', headers=headers)

    @app.get('/api/tags/{session}/{frame_id}')
    def tags(session: str, frame_id: str):
        _, frame = item_and_frame(session, frame_id)
        return {'tags': frame.tags}

    @app.get('/api/overlays/{session}/{frame_id}')
    async def overlays(session: str, frame_id: str):
        planes = await anyio.to_thread.run_sync(from_frame, session, frame_id, read_overlays,
                                                limiter=decodes)
        return {'overlays': planes}

    app.mount('/', StaticFiles(directory=WEB, html=True, check_dir=False), name='viewer')
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1', help='Bind IP address (default: 127.0.0.1).')
    parser.add_argument('--port', type=int, default=8765, help='HTTP port (default: 8765).')
    parser.add_argument('--library', type=Path, help='Allow opening this DICOM folder from the viewer.')
    parser.add_argument('--library-store', type=Path,
                        help='Store uploaded DICOM files in this writable folder.')
    parser.add_argument('--no-pairing', action='store_true',
                        help='Allow direct access without pairing on a trusted local network.')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    try:
        bound_address(args.host)
    except ValueError:
        parser.error('host must be a literal IP address or localhost')
    try:
        app = create_app(args.library, args.host, args.port, args.library_store,
                         no_pairing=args.no_pairing)
    except (OSError, ValueError):
        parser.error('the configured library and store must be accessible directories')

    # Parser warnings can carry source values or names; never write them to the terminal.
    warnings.simplefilter('ignore', UserWarning)
    for name in ('pydicom', 'python_multipart', 'multipart'):
        logger = logging.getLogger(name)
        logger.addHandler(logging.NullHandler())
        logger.propagate = False
    if app.state.pairing_path:
        print(f'LAN pairing path: {app.state.pairing_path}', flush=True)
        print('Append this path to the server URL. Use only a trusted LAN: HTTP is not encrypted.', flush=True)
    uvicorn.run(app, host=args.host, port=args.port, access_log=False, proxy_headers=False,
                server_header=False, limit_concurrency=24, ws='none')


if __name__ == '__main__':
    main()
