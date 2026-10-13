import base64
import gzip
import hashlib
import json
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from snapshot import (AnonymousClient, SOURCE, attachment_refs, dynamic_fields,
                      capture, layer_refs, public_candidates, safe_url, sanitize, snapshot_bytes,
                      verify_public_membership)


class SnapshotTests(unittest.TestCase):
    def test_public_scope_requires_both_anonymous_submitted_and_seed_id(self):
        rows = [{'submission_id': 1, 'submission_state': 'SUBMITTED'},
                {'submission_id': 2, 'submission_state': 'DRAFT'},
                {'submission_id': 3, 'submission_state': 'SUBMITTED'}]
        self.assertEqual(public_candidates(rows, {'1', '2'}), [rows[0]])

    def test_duplicate_public_id_stops_capture(self):
        row = {'submission_id': 1, 'submission_state': 'SUBMITTED'}
        with self.assertRaises(ValueError):
            public_candidates([row, row], {'1'})

    def test_public_record_state_change_stops_capture_with_same_ids(self):
        before = [{'submission_id': 1, 'form_id': 9, 'submission_state': 'SUBMITTED'}]
        after = [{**before[0], 'submission_state': 'DRAFT'}]
        with self.assertRaises(ValueError):
            verify_public_membership(before, after, {'1'})

    def test_public_record_form_reassignment_stops_capture_with_same_ids(self):
        before = [{'submission_id': 1, 'form_id': 9, 'submission_state': 'SUBMITTED'}]
        after = [{**before[0], 'form_id': 10}]
        with self.assertRaises(ValueError):
            verify_public_membership(before, after, {'1'})

    def test_every_read_requires_explicit_anonymous_success(self):
        client = AnonymousClient.__new__(AnonymousClient)
        for flag in [True, None, 0, 'false']:
            client.request = lambda *_: json.dumps({'status': 'success', 'loggedIn': flag}).encode()
            with self.assertRaises(ValueError):
                client.read('getForms.php', {})
        client.request = lambda *_: b'{"status":"success","loggedIn":false,"attributes":[]}'
        self.assertEqual(client.read('getForms.php', {})['attributes'], [])

    def test_contradictory_success_and_nonobject_envelopes_are_rejected(self):
        client = AnonymousClient.__new__(AnonymousClient)
        for envelope in [{'status': 'success', 'success': False, 'loggedIn': False, 'attributes': []},
                         [], False, None, 0]:
            client.request = lambda *_, value=envelope: json.dumps(value).encode()
            with self.assertRaises(ValueError):
                client.read('getForms.php', {})

    def test_typed_non_content_values_retained(self):
        value = {'zero': 0, 'false': False, 'empty': '', 'array': [], 'null': None,
                 'nested': [1, '1', True, '=-1']}
        clean, _ = sanitize(value, '12', 'text', [])
        self.assertEqual(clean, value)
        self.assertIs(clean['false'], False)
        self.assertIsNone(clean['null'])

    def test_unsanitized_dictionary_keys_fail_closed_without_renaming(self):
        source = {'data:image/png;base64,aGVsbG8=': 0}
        clean, _ = sanitize(source, '12', 'text', [])
        self.assertEqual(clean, source)
        with self.assertRaises(ValueError):
            snapshot_bytes({'records': [{'fields': [{'value': clean}]}]})

    def test_base64_image_has_real_digest_and_source_reference(self):
        media = []
        payload = base64.b64encode(b'example-image-bytes').decode()
        value = '<p>Before</p><img alt="source photo" src="data:image/png;base64,' + payload + '"><p>After</p>'
        clean, text = sanitize(value, '7', 'htmleditor', media)
        self.assertNotIn('base64', clean)
        self.assertIn('Before', clean)
        self.assertIn('After', text)
        self.assertEqual(media[0]['sha256'], hashlib.sha256(b'example-image-bytes').hexdigest())
        self.assertEqual(media[0]['sourceUrl'], SOURCE)
        self.assertNotIn('url', media[0])

    def test_percent_encoded_data_svg_is_removed(self):
        media = []
        clean, _ = sanitize('<img src="data:image/svg+xml,%3Csvg%3Ehi%3C/svg%3E">', '8', 'htmleditor', media)
        self.assertNotIn('data:', clean)
        self.assertEqual(media[0]['sha256'], hashlib.sha256(b'<svg>hi</svg>').hexdigest())

    def test_wrapped_base64_and_style_data_are_removed(self):
        media = []
        clean, _ = sanitize('<div style="background:url(data:image/png;base64,aGVs\nbG8=)">Content</div>', '8', 'htmleditor', media)
        self.assertEqual(media[0]['sha256'], hashlib.sha256(b'hello').hexdigest())
        self.assertNotIn('base64', clean)
        self.assertIn('Content', clean)

    def test_active_html_attributes_and_elements_removed(self):
        media = []
        clean, _ = sanitize('<script>secret()</script><p onclick="evil()">Safe<a href="javascript:evil()">text</a></p>', '1', 'htmleditor', media)
        self.assertNotIn('script', clean)
        self.assertNotIn('secret', clean)
        self.assertNotIn('onclick', clean)
        self.assertNotIn('javascript', clean)
        self.assertIn('Safe', clean)

    def test_media_removed_with_blocked_content_still_gets_provenance(self):
        media = []
        clean, _ = sanitize('<style>.x{background:url(data:image/png;base64,aGVsbG8=)}</style><object data="data:image/png;base64,aGVsbG8="></object><p>Text</p>', '8', 'htmleditor', media)
        self.assertEqual(len(media), 2)
        self.assertEqual([x['sha256'] for x in media], [hashlib.sha256(b'hello').hexdigest()] * 2)
        self.assertNotIn('base64', clean)
        self.assertNotIn('background', clean)
        self.assertIn('Text', clean)

    def test_remote_media_resolves_against_actual_source_only(self):
        media = []
        clean, _ = sanitize('<img src="/images/example.png" alt="Example">', '8', 'htmleditor', media)
        self.assertIn(SOURCE + 'images/example.png', clean)
        self.assertEqual(media[0]['url'], SOURCE + 'images/example.png')
        self.assertNotIn('sha256', media[0])

    def test_bad_urls_and_anchors_are_rejected(self):
        for url in ['javascript:alert(1)', 'data:image/png;base64,aGVsbG8=', '#',
                    'https://user:password@example.com/file', '<a href="x">file</a>', '']:
            self.assertIsNone(safe_url(url))

    def test_attachment_opaque_post_path_is_never_fabricated_get_url(self):
        refs = attachment_refs({'attributes': [{'fileId': 5, 'name': 'Report',
                                               'download': 'portal/downloadFile.php', 'metadata': 'private-adjacent'}]})
        self.assertEqual(refs, [{'id': '5', 'name': 'Report', 'sourceUrl': SOURCE}])

    def test_attachment_explicit_safe_href_retained(self):
        refs = attachment_refs({'attributes': [{'fileId': 5, 'name': 'Report',
                                               'download': '<a href="https://example.com/report.pdf">Report</a>'}]})
        self.assertEqual(refs[0]['url'], 'https://example.com/report.pdf')

    def test_layer_curates_only_anonymous_reference_metadata(self):
        refs = layer_refs({'attributes': [{'layer_id': 386, 'layer_name': 'Example', 'schema_id': 13,
                                          'has_style': False, 'extra': 'omitted'}]}, 'direct')
        self.assertEqual(refs, [{'id': '386', 'name': 'Example', 'schemaId': '13', 'kind': 'direct', 'sourceUrl': SOURCE}])

    def test_source_field_index_resets_at_static_node(self):
        dynamic = lambda fid: {'field_id': fid, 'field_label': 'Field', 'field_type': 'text', 'nodeInfo': {'node_is_dynamic': True}}
        fields = dynamic_fields({'attributes': {'nodes': [dynamic(1), dynamic(2), {'nodeInfo': {'node_is_dynamic': False}}, dynamic(3)]}})
        self.assertEqual([f['index'] for f in fields], [0, 1, 0])

    def test_gzip_is_deterministic_for_identical_snapshot_bytes(self):
        raw = b'{"schema":"nechako-public-content-v1","records":[]}\n'
        first = gzip.compress(raw, compresslevel=9, mtime=0)
        self.assertEqual(first, gzip.compress(raw, compresslevel=9, mtime=0))
        self.assertEqual(gzip.decompress(first), raw)

    def capture_fixture(self, deny_missing=False, unseeded=False):
        class FakeClient:
            def read(self, route, params):
                attributes = None
                if route == 'getSearchResults.php':
                    attributes = {'results': [{'submission_id': 1, 'submission_state': 'SUBMITTED',
                                               'form_id': 9, 'submission_title': 'Public title',
                                               'submission_name': 'Public name', 'parent_id': -1,
                                               'submitted_by': 'Public author'}]}
                    if unseeded:
                        attributes['results'].append({**attributes['results'][0], 'submission_id': 4})
                elif route == 'getForms.php':
                    attributes = [{'form_id': 9, 'form_name': 'Public form'}]
                elif route == 'getForm.php':
                    attributes = {'nodes': [{'field_id': x, 'field_label': 'Public field', 'field_type': 'text',
                                              'field_node_page': 1, 'field_node_rank': 0, 'field_rank': str(x-9),
                                              'field_node_type': 2, 'nodeInfo': {'node_is_dynamic': True, 'node_name': 'dynamiccontentNode.form'}} for x in [10, 11, 12, 13]]}
                elif route == 'GetFormStatistics.php':
                    attributes = {'rows': {'1': {'field_10': False, 'field_11': 0, 'field_12': []}}}
                elif route == 'getFieldValue.php':
                    if deny_missing:
                        raise ValueError('Anonymous field access denied')
                    attributes = ''
                elif route in ('getSubmissionAttachments.php', 'getSubmissionLayers.php', 'getSubmissionLinkedLayers.php'):
                    attributes = []
                else:
                    raise AssertionError('Unapproved source route')
                return {'status': 'success', 'loggedIn': False, 'attributes': attributes}

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); seed = root / 'seed'; out = root / 'out'
            (seed / 'catalogues').mkdir(parents=True)
            (seed / 'catalogues/admin-submissions.json').write_text(json.dumps({'attributes': [
                {'sub_id': 1, 'sub_state': 'SUBMITTED', 'sub_title': 'PRIVATE ADMIN TITLE'},
                {'sub_id': 2, 'sub_state': 'SUBMITTED'}, {'sub_id': 3, 'sub_state': 'DRAFT'}]}))
            with patch('snapshot.AnonymousClient', FakeClient), contextlib.redirect_stdout(io.StringIO()):
                capture(None if unseeded else seed, out, 1, '2026-10-12T00:00:00Z')
            raw = gzip.decompress((out / 'submissions.json.gz').read_bytes())
            return raw, json.loads(raw), json.loads((out / 'manifest.json').read_text())

    def test_capture_never_copies_private_catalogue_text_or_hidden_ids(self):
        raw, document, manifest = self.capture_fixture()
        self.assertNotIn(b'PRIVATE ADMIN TITLE', raw)
        self.assertEqual([x['id'] for x in document['records']], ['1'])
        record = document['records'][0]
        self.assertEqual([x['value'] for x in record['fields']], [False, 0, [], ''])
        self.assertIs(record['fields'][0]['value'], False)
        self.assertEqual(record['submittedBy'], 'Public author')
        self.assertEqual(record['sourceType'], 'submission')
        self.assertEqual(manifest['verification']['seedDraftsExcluded'], 1)
        self.assertEqual(manifest['omissions']['seedSubmittedAbsentAnonymously'], 1)

    def test_denied_anonymous_field_is_omitted_without_seed_fallback(self):
        _, document, manifest = self.capture_fixture(deny_missing=True)
        self.assertEqual([x['id'] for x in document['records'][0]['fields']], ['10', '11', '12'])
        self.assertEqual(manifest['omissions']['unverifiedFields'], 1)

    def test_fixed_timestamp_capture_compression_is_deterministic(self):
        first, _, _ = self.capture_fixture()
        second, _, _ = self.capture_fixture()
        self.assertEqual(first, second)

    def test_unseeded_capture_is_anonymous_source_of_truth(self):
        raw, document, manifest = self.capture_fixture(unseeded=True)
        self.assertEqual([r['id'] for r in document['records']], ['1', '4'])
        self.assertIs(manifest['verification']['seedApplied'], False)
        self.assertIsNone(manifest['verification']['seedSubmittedCount'])
        self.assertEqual(manifest['omissions']['seedSubmittedAbsentAnonymously'], 0)
        self.assertNotIn(b'PRIVATE ADMIN TITLE', raw)


if __name__ == '__main__':
    unittest.main()
