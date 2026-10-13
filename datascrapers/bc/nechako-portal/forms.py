#!/usr/bin/env python3
"""Refresh anonymously verified form layout metadata without recapturing submissions."""
import argparse
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re

from snapshot import (AnonymousClient, SOURCE, public_candidates, sanitize, snapshot_bytes,
                      verify_public_membership)

NODE_TYPES = {
    'dynamiccontentnode.form': 'dynamic',
    'parentsubmissionnode.form': 'parent',
    'permissionsnode.form': 'permissions',
    'attachmentsnode.form': 'attachments',
    'shapefilenode.form': 'spatial',
    'linkablelayersnode.form': 'linked',
    'monitoringnode.form': 'monitoring',
    'notificationnode.form': 'notifications',
}
SAFE_NODE_NAME = re.compile(r'^[A-Za-z0-9_-]+(?:\.form)?$')
OPTION_KEYS = {'id', 'value', 'label', 'text', 'name', 'disabled', 'selected', 'options', 'items'}


def clean_options(value, field_id, media):
    if isinstance(value, str):
        # Encoded source option arrays are data, not scripts or component configuration.
        if not value.lstrip().startswith(('[', '{')):
            return sanitize(value, field_id, 'htmleditor', media)[1]
        try:
            parsed = json.loads(value)
        except ValueError:
            return sanitize(value, field_id, 'htmleditor', media)[1]
        return clean_options(parsed, field_id, media)
    if isinstance(value, list):
        if len(value) > 500:
            raise ValueError('Source choice array exceeds the form metadata bound')
        return [clean_options(item, field_id, media) for item in value]
    if isinstance(value, dict):
        return {key: clean_options(item, field_id, media) for key, item in value.items()
                if key in OPTION_KEYS}
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise ValueError('Unsupported source option value')


def source_attribute(node, keys):
    for key in keys:
        if key in node:
            return True, node[key]
    return False, None


def curate_form(form_id, envelope, name=None):
    if not isinstance(envelope, dict) or envelope.get('status') != 'success' or envelope.get('success') is False or envelope.get('error') or envelope.get('loggedIn') is not False:
        raise ValueError('Form definition is not a successful explicit anonymous response')
    attrs = envelope.get('attributes')
    if not isinstance(attrs, dict) or not isinstance(attrs.get('nodes'), list) or len(attrs['nodes']) > 1000:
        raise ValueError('Invalid or oversized form definition')
    media, nodes, pages = [], [], []
    page_ids = set()
    for source in attrs['nodes']:
        if not isinstance(source, dict):
            raise ValueError('Source node must be an object')
        info = source.get('nodeInfo', {})
        if not isinstance(info, dict):
            raise ValueError('Invalid source node metadata')
        dynamic = info.get('node_is_dynamic') in (True, 1, '1', 'true', 't')
        fid = str(source['field_id']) if source.get('field_id') is not None else None
        node_name = info.get('node_name')
        if not isinstance(node_name, str) or not SAFE_NODE_NAME.fullmatch(node_name):
            node_name = None
        label = sanitize(source.get('field_label', ''), fid or '', 'htmleditor', media)[1]
        node = {'label': label, 'type': str(source.get('field_type', '')), 'dynamic': dynamic,
                'nodeType': str(source.get('field_node_type', '')),
                'semanticType': 'dynamic' if dynamic else NODE_TYPES.get((node_name or '').lower(), 'static')}
        if fid is not None:
            node['fieldId'] = fid
        if node_name is not None:
            node['nodeName'] = node_name
        for source_key, output_key in [('field_node_page', 'page'), ('field_node_rank', 'nodeRank'), ('field_rank', 'fieldRank')]:
            value = source.get(source_key)
            if not isinstance(value, (str, int)) or isinstance(value, bool):
                raise ValueError('Source node rank/page must retain a valid integer or string')
            node[output_key] = value
        page = node['page']
        if str(page) not in page_ids:
            pages.append({'id': page})
            page_ids.add(str(page))
        # Permission nodes are layout markers only: never publish permission assignments/options.
        if dynamic:
            present, required = source_attribute(source, ('field_required', 'required'))
            if present and isinstance(required, (bool, int, str)):
                node['required'] = required
            present, options = source_attribute(source, ('field_options', 'options'))
            if present:
                node['options'] = clean_options(options, fid or '', media)
        present, content = source_attribute(source, ('field_content', 'content'))
        if present and isinstance(content, str) and node['semanticType'] != 'permissions':
            node['content'] = sanitize(content, fid or '', 'htmleditor', media)[0]
        nodes.append(node)
    form_name = attrs.get('name') if name is None else name
    cleaned_name = sanitize(form_name if isinstance(form_name, str) else '', '', 'htmleditor', media)[1]
    result = {'id': str(form_id), 'name': cleaned_name, 'pages': pages, 'nodes': nodes}
    # Future native payloads may explicitly provide page labels; only retain known IDs.
    source_pages = attrs.get('pages')
    if isinstance(source_pages, list):
        labels = {str(p['id']): p['label'] for p in source_pages
                  if isinstance(p, dict) and 'id' in p and isinstance(p.get('label'), str)}
        for page in pages:
            if str(page['id']) in labels:
                page['label'] = sanitize(labels[str(page['id'])], '', 'htmleditor', media)[1]
    if media:
        result['media'] = media
    return result


def publish_forms(output, definitions, names, captured_at):
    forms = [curate_form(fid, definition, names.get(fid))
             for fid, definition in sorted(definitions.items(), key=lambda pair: int(pair[0]))]
    document = {'schema': 'nechako-public-form-definitions-v1', 'source': SOURCE,
                'capturedAt': captured_at, 'forms': forms}
    raw = snapshot_bytes(document)
    compressed = gzip.compress(raw, compresslevel=9, mtime=0)
    manifest_path = output / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['files']['forms.json.gz'] = {'bytes': len(compressed), 'sha256': hashlib.sha256(compressed).hexdigest(),
                                         'uncompressedBytes': len(raw), 'uncompressedSha256': hashlib.sha256(raw).hexdigest()}
    manifest['formCount'] = len(forms)
    manifest['formNodeCount'] = sum(len(form['nodes']) for form in forms)
    manifest['formsCapturedAt'] = captured_at
    manifest['verification']['formDefinitionMethods'] = ['getSearchResults.php', 'getForms.php', 'getForm.php']
    manifest['verification']['formDefinitionsExplicitAnonymous'] = True
    manifest['verification']['formDefinitionsScopeVerifiedAfterCapture'] = True
    output.mkdir(parents=True, exist_ok=True)
    (output / 'forms.json.gz').write_bytes(compressed)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return document


def refresh_forms(output, captured_at):
    content_path = output / 'submissions.json.gz'
    content_bytes = content_path.read_bytes()
    content_sha = hashlib.sha256(content_bytes).hexdigest()
    records = json.loads(gzip.decompress(content_bytes))['records']
    expected = [{'submission_id': record['id'], 'form_id': record['formId'], 'submission_state': 'SUBMITTED'}
                for record in records]
    ids = {record['id'] for record in records}
    form_ids = {record['formId'] for record in records}
    client = AnonymousClient()
    params = {'keys': json.dumps({'token': 'comparator', 'value': '>=', 'left': {'token': 'column', 'value': 'Submission ID'}, 'right': {'token': 'number', 'value': '1'}}), 'fields': '["Submission ID"]', 'area': 'null'}
    try:
        before = client.read('getSearchResults.php', params)['attributes']['results']
        # Existing records must remain anonymously submitted with their recorded forms.
        signature = lambda rows: {(str(r['submission_id']), str(r['form_id']), r['submission_state'])
                                  for r in public_candidates(rows, ids)}
        if signature(before) != signature(expected):
            raise ValueError('Existing public content cohort no longer matches anonymous forms')
        names = {str(row['form_id']): row['form_name'] for row in client.read('getForms.php', {})['attributes']}
        definitions = {}
        for fid in sorted(form_ids, key=int):
            definitions[fid] = client.read('getForm.php', {'id': fid})
            print(json.dumps({'stage': 'anonymous-form-definition', 'formId': fid,
                              'nodes': len(definitions[fid]['attributes']['nodes'])}), flush=True)
        after = client.read('getSearchResults.php', params)['attributes']['results']
        verify_public_membership(before, after, ids)
        document = publish_forms(output, definitions, names, captured_at)
        if hashlib.sha256(content_path.read_bytes()).hexdigest() != content_sha:
            raise ValueError('Submission content changed during forms-only refresh')
        print(json.dumps({'stage': 'forms-finished', 'forms': len(document['forms']),
                          'nodes': sum(len(f['nodes']) for f in document['forms']),
                          'submissionContentSha256': content_sha}), flush=True)
    finally:
        client.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'output')
    parser.add_argument('--captured-at', default=datetime.datetime.now(datetime.timezone.utc).isoformat())
    args = parser.parse_args()
    refresh_forms(args.output, args.captured_at)
