#!/usr/bin/env python3
"""Capture only anonymously returned submitted Nechako content, without media bodies."""
import argparse
import base64
import concurrent.futures
import datetime
import gzip
import hashlib
import html
from html.parser import HTMLParser
import http.client
import http.cookies
import json
from pathlib import Path
import re
import threading
import urllib.parse

SOURCE = 'https://nechakowatershed-portal.ca/'
HOST = 'nechakowatershed-portal.ca'
CONTENT_LIMIT = 128 * 1024 * 1024
READ_LIMIT = 20 * 1024 * 1024
ROUTES = {'getSearchResults.php', 'getForms.php', 'getForm.php', 'GetFormStatistics.php',
          'getFieldValue.php', 'getSubmissionAttachments.php', 'getSubmissionLayers.php',
          'getSubmissionLinkedLayers.php'}
DATA = re.compile(r'data:([a-zA-Z0-9.+/-]*)([^,\s]*),([^\"\'<>)]*)', re.IGNORECASE)


def safe_url(value):
    if not isinstance(value, str) or not value.strip() or value.strip().startswith('#') or any(ord(c) < 32 or c in '<>"\\' for c in value):
        return None
    url = urllib.parse.urljoin(SOURCE, value.strip())
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        return None
    return url


class ContentParser(HTMLParser):
    tags = {'p', 'div', 'span', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b',
            'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th',
            'td', 'a', 'img', 'blockquote', 'pre', 'code', 'hr', 'figure', 'figcaption'}
    blocked = {'script', 'style', 'iframe', 'object', 'embed'}
    void = {'br', 'img', 'hr'}

    def __init__(self, field_id, media):
        super().__init__(convert_charrefs=True)
        self.field_id, self.media, self.output, self.text = field_id, media, [], []
        self.block_depth = 0

    def strip_data(self, value):
        def replace(match):
            mime, parameters, payload = match.groups()
            try:
                if ';base64' in parameters.lower():
                    decoded = base64.b64decode(re.sub(r'\s', '', payload), validate=True)
                else:
                    decoded = urllib.parse.unquote_to_bytes(payload)
            except ValueError:
                decoded = match.group(0).encode()
            self.media.append({'fieldId': self.field_id, 'ordinal': len(self.media) + 1,
                               'mime': mime.lower() or 'application/octet-stream', 'sha256': hashlib.sha256(decoded).hexdigest(),
                               'sourceUrl': SOURCE, 'kind': 'embedded'})
            return '[Embedded media available in source submission]'
        return DATA.sub(replace, value)

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        # Every removed data URI gets provenance, including discarded CSS/embed attributes.
        clean = {k: self.strip_data(v or '') for k, v in attrs}
        if tag in self.blocked:
            self.block_depth += 1
        if self.block_depth:
            return
        if tag not in self.tags:
            return
        attrs_out = []
        if tag in ('a', 'img'):
            key = 'href' if tag == 'a' else 'src'
            url = safe_url(clean.get(key))
            original = dict(attrs).get(key) or ''
            if 'data:' in original.lower():
                if tag == 'img':
                    self.output.append('<p>[Embedded media available in source submission]</p>')
                return
            if url:
                attrs_out.append((key, url))
                if tag == 'img':
                    self.media.append({'fieldId': self.field_id, 'ordinal': len(self.media) + 1,
                                       'mime': 'image/unknown', 'sourceUrl': SOURCE,
                                       'kind': 'remote', 'url': url})
            elif tag == 'img':
                return
        for key in ('alt', 'title'):
            if key in clean:
                attrs_out.append((key, clean[key]))
        if tag in ('td', 'th'):
            for key in ('colspan', 'rowspan'):
                if clean.get(key, '').isdigit() and 0 < int(clean[key]) <= 100:
                    attrs_out.append((key, clean[key]))
        encoded = ''.join(' ' + k + '="' + html.escape(v, quote=True) + '"' for k, v in attrs_out)
        self.output.append('<' + tag + encoded + '>')

    def handle_endtag(self, tag):
        if tag in self.blocked:
            self.block_depth = max(0, self.block_depth - 1)
            return
        if not self.block_depth and tag in self.tags and tag not in self.void:
            self.output.append('</' + tag + '>')

    def handle_data(self, value):
        value = self.strip_data(value)
        if not self.block_depth:
            self.output.append(html.escape(value, quote=False))
            self.text.append(value)


def sanitize(value, field_id, field_type, media):
    if isinstance(value, str):
        parser = ContentParser(field_id, media)
        if field_type == 'htmleditor':
            parser.feed(value)
            parser.close()
            return ''.join(parser.output), ' '.join(parser.text)
        clean = parser.strip_data(value)
        return clean, clean
    if isinstance(value, list):
        pairs = [sanitize(x, field_id, field_type, media) for x in value]
        return [x[0] for x in pairs], ' '.join(x[1] for x in pairs)
    if isinstance(value, dict):
        pairs = {k: sanitize(v, field_id, field_type, media) for k, v in value.items()}
        return {k: v[0] for k, v in pairs.items()}, ' '.join(v[1] for v in pairs.values())
    return value, '' if value is None else str(value)


def dynamic_fields(definition):
    fields, index = [], 0
    for node in definition['attributes']['nodes']:
        if node.get('nodeInfo', {}).get('node_is_dynamic') not in (True, 1, '1', 'true', 't'):
            index = 0
            continue
        fields.append({'id': str(node['field_id']), 'label': node['field_label'],
                       'type': node['field_type'], 'index': index})
        index += 1
    if len({f['id'] for f in fields}) != len(fields):
        raise ValueError('Duplicate dynamic source field IDs')
    return fields


class AnonymousClient:
    def __init__(self):
        self.connection = None
        self.cookies = {}
        self.request('', None)

    def request(self, route, params):
        if route and route not in ROUTES:
            raise ValueError('Unverified source route')
        for attempt in range(2):
            try:
                if self.connection is None:
                    self.connection = http.client.HTTPSConnection(HOST, timeout=60)
                body = urllib.parse.urlencode(params).encode() if params is not None else None
                headers = {'Referer': SOURCE, 'X-Requested-With': 'XMLHttpRequest',
                           'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                           'Accept-Encoding': 'identity', 'User-Agent': 'BCDataMapper-Nechako-PublicContent/1.0'}
                if self.cookies:
                    headers['Cookie'] = '; '.join(k + '=' + v for k, v in self.cookies.items())
                path = '/rest/portal/' + route if route else '/'
                self.connection.request('POST' if body is not None else 'GET', path, body, headers)
                response = self.connection.getresponse()
                limit = CONTENT_LIMIT if route in ('GetFormStatistics.php', 'getFieldValue.php') else READ_LIMIT
                raw = response.read(limit + 1)
                for key, value in response.getheaders():
                    if key.lower() == 'set-cookie':
                        jar = http.cookies.SimpleCookie(); jar.load(value)
                        self.cookies.update({k: v.value for k, v in jar.items()})
                if response.status != 200 or len(raw) > limit:
                    self.connection.close()
                    self.connection = None
                    raise ValueError('Source HTTP failure or bounded response exceeded')
                return raw
            except (OSError, http.client.HTTPException):
                if self.connection:
                    self.connection.close()
                self.connection = None
                if attempt:
                    raise

    def read(self, route, params):
        value = json.loads(self.request(route, params))
        if not isinstance(value, dict) or value.get('status') != 'success' or value.get('success') is False or value.get('error') or value.get('loggedIn') is not False:
            raise ValueError('Read was not a successful explicitly anonymous source response')
        return value

    def close(self):
        if self.connection:
            self.connection.close()
        self.cookies.clear()


def attachment_refs(envelope):
    refs = []
    for row in envelope['attributes']:
        item = {'id': str(row['fileId']), 'name': row['name'], 'sourceUrl': SOURCE}
        # Source download may itself be markup. Keep only safe extracted hrefs.
        raw = row.get('download', '')
        parser = ContentParser('', []); parser.feed(raw)
        href = re.search(r'href="([^"]+)"', ''.join(parser.output))
        url = safe_url(html.unescape(href.group(1))) if href else None
        if url:
            item['url'] = url
        refs.append(item)
    return refs


def layer_refs(envelope, kind):
    refs = []
    for row in envelope['attributes']:
        item = {'id': str(row['layer_id']), 'name': row['layer_name'], 'kind': kind, 'sourceUrl': SOURCE}
        if row.get('schema_id') is not None:
            item['schemaId'] = str(row['schema_id'])
        refs.append(item)
    return refs


def public_candidates(search_rows, seed_ids=None):
    candidates = [r for r in search_rows if (seed_ids is None or str(r['submission_id']) in seed_ids) and r['submission_state'] == 'SUBMITTED']
    if len({str(r['submission_id']) for r in candidates}) != len(candidates):
        raise ValueError('Duplicate public source IDs')
    return candidates


def verify_public_membership(before, after, seed_ids=None):
    if {str(r['submission_id']) for r in before} != {str(r['submission_id']) for r in after}:
        raise ValueError('Anonymous catalogue changed during capture; review and rerun before publishing')
    signature = lambda rows: {(str(r['submission_id']), str(r['form_id']), r['submission_state'])
                              for r in public_candidates(rows, seed_ids)}
    if signature(before) != signature(after):
        raise ValueError('Anonymous submitted cohort or form association changed during capture')


def snapshot_bytes(document):
    raw = (json.dumps(document, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()
    # A URI can appear in an unknown dictionary key or curated metadata as well as a value.
    # Fail closed rather than rename keys, collide values, or deploy overlooked media bodies.
    if DATA.search(raw.decode()):
        raise ValueError('Unsanitized data URI remains; snapshot publication stopped')
    return raw


def capture(seed, output, workers, captured_at):
    # Read only the private catalogue ID/state seed. Never copy its text or fields.
    source_seed = json.loads((seed / 'catalogues/admin-submissions.json').read_text())['attributes'] if seed is not None else None
    seed_ids = {str(r['sub_id']) for r in source_seed if r['sub_state'] == 'SUBMITTED'} if source_seed is not None else None
    main = AnonymousClient(); clients = [main]; lock = threading.Lock(); local = threading.local()
    try:
        search_params = {'keys': json.dumps({'token': 'comparator', 'value': '>=', 'left': {'token': 'column', 'value': 'Submission ID'}, 'right': {'token': 'number', 'value': '1'}}), 'fields': '["Submission ID"]', 'area': 'null'}
        search = main.read('getSearchResults.php', search_params)
        search_rows = search['attributes']['results']
        candidates = public_candidates(search_rows, seed_ids)
        if seed_ids is None:
            seed_ids = {str(row['submission_id']) for row in candidates}
        names = {str(r['form_id']): r['form_name'] for r in main.read('getForms.php', {})['attributes']}
        fields, reports, definitions, omissions = {}, {}, {}, {'seedSubmittedAbsentAnonymously': len(seed_ids - {str(r['submission_id']) for r in candidates}), 'unverifiedFields': 0, 'unverifiedInventories': 0, 'unreadableForms': 0, 'unreadableSubmissions': 0, 'bulkReportsUnavailable': 0}
        for fid in sorted({str(r['form_id']) for r in candidates}, key=int):
            try:
                definition = main.read('getForm.php', {'id': fid})
                fields[fid] = dynamic_fields(definition)
                definitions[fid] = definition
            except (ValueError, OSError, http.client.HTTPException):
                omissions['unreadableForms'] += 1
                continue
            try:
                report = main.read('GetFormStatistics.php', {'formId': fid, 'mapping': json.dumps({f['id']: 'field_' + f['id'] for f in fields[fid]})})['attributes']['rows']
                if not isinstance(report, dict) and report != []:
                    raise ValueError('Invalid source report rows')
                reports[fid] = report if isinstance(report, dict) else {}
            except (ValueError, OSError, http.client.HTTPException):
                omissions['bulkReportsUnavailable'] += 1
                reports[fid] = {}
            print(json.dumps({'stage': 'anonymous-form', 'formId': fid, 'fields': len(fields[fid]), 'bulkRows': len(reports[fid])}), flush=True)

        def client():
            if not hasattr(local, 'client'):
                local.client = AnonymousClient()
                with lock:
                    clients.append(local.client)
            return local.client

        def record(row):
            sid, fid = str(row['submission_id']), str(row['form_id'])
            if fid not in fields:
                return None, {'unverifiedFields': 0, 'unverifiedInventories': 0, 'unreadableSubmissions': 1}
            result = {'id': sid, 'title': row.get('submission_title') or row.get('submission_name') or '', 'name': row.get('submission_name') or '', 'formId': fid, 'formName': names.get(fid, ''), 'date': row.get('submission_date'), 'sourceUrl': SOURCE, 'fields': [], 'attachments': [], 'layers': [], 'media': []}
            if 'submitted_by' in row:
                result['submittedBy'] = row['submitted_by']
            if 'parent_id' in row:
                result['parentId'] = row['parent_id']
                result['sourceType'] = 'submission' if row['parent_id'] == -1 or row['parent_id'] == '-1' else 'activity'
            text = [result['title'], result['name'], result['formName']]; omitted = {'unverifiedFields': 0, 'unverifiedInventories': 0}; bulk = reports[fid].get(sid, {})
            for field in fields[fid]:
                key = 'field_' + field['id']
                if isinstance(bulk, dict) and key in bulk:
                    value = bulk[key]
                else:
                    try:
                        value = client().read('getFieldValue.php', {'submissionId': sid, 'fieldId': field['id'], 'fieldIndex': str(field['index'])})['attributes']
                    except (ValueError, OSError, http.client.HTTPException):
                        omitted['unverifiedFields'] += 1
                        continue
                value, plain = sanitize(value, field['id'], field['type'], result['media'])
                result['fields'].append({'id': field['id'], 'label': field['label'], 'type': field['type'], 'value': value}); text.extend([field['label'], plain])
            for route, destination, converter in [('getSubmissionAttachments.php', 'attachments', attachment_refs), ('getSubmissionLayers.php', 'layers', lambda x: layer_refs(x, 'direct')), ('getSubmissionLinkedLayers.php', 'layers', lambda x: layer_refs(x, 'linked'))]:
                try:
                    envelope = client().read(route, {'submissionId': sid})
                    if not isinstance(envelope['attributes'], list):
                        raise ValueError('Invalid inventory')
                    result[destination].extend(converter(envelope))
                except (ValueError, OSError, http.client.HTTPException):
                    omitted['unverifiedInventories'] += 1
            text.extend(x['name'] for x in result['attachments'] + result['layers'])
            result['searchText'] = ' '.join(' '.join(str(x) for x in text).split())
            return result, omitted

        records = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(record, row) for row in candidates]
            for future in concurrent.futures.as_completed(futures):
                result, omitted = future.result()
                for key, n in omitted.items():
                    omissions[key] += n
                if result is not None:
                    records.append(result)
                if len(records) % 50 == 0:
                    print(json.dumps({'stage': 'anonymous-records', 'records': len(records), 'total': len(candidates), 'omissions': omissions}), flush=True)
        records.sort(key=lambda r: int(r['id']))
        after = main.read('getSearchResults.php', search_params)['attributes']['results']
        verify_public_membership(search_rows, after, seed_ids)
        document = {'schema': 'nechako-public-content-v1', 'source': SOURCE, 'capturedAt': captured_at, 'records': records}
        raw = snapshot_bytes(document)
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        manifest = {'schema': 'nechako-public-content-manifest-v1', 'source': SOURCE, 'capturedAt': captured_at, 'scope': 'Anonymously visible submitted records; each included field and inventory returned successfully with loggedIn:false. Private export used only for submitted ID eligibility.', 'recordCount': len(records), 'fieldCount': sum(len(r['fields']) for r in records), 'mediaCount': sum(len(r['media']) for r in records), 'attachmentCount': sum(len(r['attachments']) for r in records), 'layerCount': sum(len(r['layers']) for r in records), 'omissions': omissions, 'files': {'submissions.json.gz': {'bytes': len(compressed), 'sha256': hashlib.sha256(compressed).hexdigest(), 'uncompressedBytes': len(raw), 'uncompressedSha256': hashlib.sha256(raw).hexdigest()}}, 'verification': {'anonymousSearchRecordCount': len(search_rows), 'seedSubmittedCount': len(seed_ids), 'methods': ['getSearchResults.php', 'getForms.php', 'getForm.php', 'GetFormStatistics.php', 'getFieldValue.php', 'getSubmissionAttachments.php', 'getSubmissionLayers.php', 'getSubmissionLinkedLayers.php'], 'sourceLink': 'Original portal requires its in-page Search/openSubmission controls; no submission deep-link URL verified.'}, 'limitations': ['Rich HTML is sanitized; inline media bytes are replaced with source references and SHA-256 digests, not remote URLs.', 'Existing remote media URLs are references only; their bodies are not fetched.', 'Attachment/spatial-file bodies and monitoring observations are excluded.', 'submittedBy and parentId are included only when returned anonymously; assignedTo, private drafts, permissions and administrative catalogue text are excluded.', 'Current form definitions describe captured values; this is not an atomic historical database snapshot.']}
        manifest['verification']['anonymousSearchVerifiedAfterCapture'] = True
        manifest['verification']['eligibleStateAndFormVerifiedAfterCapture'] = True
        manifest['verification']['anonymousSearchAddedDuringCapture'] = 0
        manifest['verification']['anonymousSearchRemovedDuringCapture'] = 0
        manifest['verification']['seedApplied'] = source_seed is not None
        manifest['verification']['seedDraftsExcluded'] = sum(row['sub_state'] == 'DRAFT' for row in source_seed) if source_seed is not None else 0
        if source_seed is None:
            manifest['verification']['seedSubmittedCount'] = None
            manifest['scope'] = 'All anonymously visible submitted records; each included field and inventory returned successfully with loggedIn:false. No private seed used.'
        output.mkdir(parents=True, exist_ok=True)
        (output / 'submissions.json.gz').write_bytes(compressed)
        (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        from forms import publish_forms
        publish_forms(output, {fid: definition for fid, definition in definitions.items()
                               if any(record['formId'] == fid for record in records)}, names, captured_at)
        print(json.dumps({'stage': 'finished', 'records': len(records), 'bytes': len(raw), 'gzipBytes': len(compressed), 'omissions': omissions}), flush=True)
    finally:
        for item in clients:
            item.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=Path, help='Optional private-export ID/state cohort; source values are always read anonymously')
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'output')
    parser.add_argument('--workers', type=int, choices=(1, 2, 4), default=4)
    parser.add_argument('--captured-at', default=datetime.datetime.now(datetime.timezone.utc).isoformat())
    args = parser.parse_args()
    capture(args.seed, args.output, args.workers, args.captured_at)
