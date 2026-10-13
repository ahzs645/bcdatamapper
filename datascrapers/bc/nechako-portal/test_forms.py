import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from forms import curate_form, publish_forms
from snapshot import snapshot_bytes


def node(fid, dynamic=True, **extra):
    return {'field_id': fid, 'field_label': 'Label', 'field_type': 'text' if dynamic else '5',
            'field_node_type': 2 if dynamic else 5, 'field_node_page': 1,
            'field_node_rank': 0 if dynamic else 1, 'field_rank': '1' if dynamic else '0',
            'nodeInfo': {'node_is_dynamic': dynamic, 'node_name': 'dynamiccontentNode.form' if dynamic else 'attachmentsNode.form'}, **extra}


def definition(nodes, **attrs):
    return {'status': 'success', 'success': True, 'loggedIn': False,
            'attributes': {'name': 'Public form', 'nodes': nodes, **attrs}}


class FormTests(unittest.TestCase):
    def test_only_explicit_anonymous_success_is_publishable(self):
        good = definition([node(1)])
        for flag in [True, None, 0, 'false']:
            with self.assertRaises(ValueError):
                curate_form('9', {**good, 'loggedIn': flag})
        with self.assertRaises(ValueError):
            curate_form('9', {**good, 'success': False})

    def test_native_array_order_and_zero_page_rank_are_preserved(self):
        result = curate_form('9', definition([node(2, field_node_page=0, field_node_rank=2), node(1, field_node_page=0, field_node_rank=0, field_rank=0)]))
        self.assertEqual([n['fieldId'] for n in result['nodes']], ['2', '1'])
        self.assertEqual(result['pages'], [{'id': 0}])
        self.assertEqual(result['nodes'][1]['fieldRank'], 0)
        self.assertEqual(result['nodes'][1]['nodeRank'], 0)

    def test_required_choices_retain_false_zero_empty_and_string_types(self):
        result = curate_form('9', definition([node(1, field_required=False,
                     field_options=[{'value': 0, 'disabled': False, 'label': ''}, '0', 'false'])]))
        n = result['nodes'][0]
        self.assertIs(n['required'], False)
        self.assertEqual(n['options'], [{'value': 0, 'disabled': False, 'label': ''}, '0', 'false'])

    def test_encoded_choices_are_parsed_without_component_execution(self):
        result = curate_form('9', definition([node(1, field_options='[{"label":"Choice","value":0,"listeners":"evil()"}]')]))
        self.assertEqual(result['nodes'][0]['options'], [{'label': 'Choice', 'value': 0}])

    def test_static_permissions_are_only_layout_marker(self):
        n = node(2, False, field_type='4', field_node_type=4,
                 field_options=[{'name': 'identity'}], content='permission assignments',
                 nodeInfo={'node_is_dynamic': False, 'node_name': 'permissionsNode.form'})
        result = curate_form('9', definition([n]))['nodes'][0]
        self.assertEqual(result['semanticType'], 'permissions')
        self.assertNotIn('options', result)
        self.assertNotIn('content', result)

    def test_arbitrary_css_javascript_and_unknown_node_config_are_omitted(self):
        result = curate_form('9', definition([node(1, field_css_class='private-style',
                                  javascript='alert(1)', listeners={'click': 'evil()'}, field_key='opaque-secret')]))
        raw = snapshot_bytes(result)
        self.assertNotIn(b'private-style', raw)
        self.assertNotIn(b'alert', raw)
        self.assertNotIn(b'opaque-secret', raw)

    def test_static_html_media_is_removed_and_safe_structure_retained(self):
        result = curate_form('9', definition([node(1, False,
                           content='<p onclick="evil()">Intro</p><img src="data:image/png;base64,aGVsbG8="><script>bad()</script>')]))
        self.assertIn('<p>Intro</p>', result['nodes'][0]['content'])
        raw = snapshot_bytes(result)
        self.assertNotIn(b'base64', raw)
        self.assertNotIn(b'bad()', raw)
        self.assertEqual(result['media'][0]['sha256'], hashlib.sha256(b'hello').hexdigest())

    def test_source_page_labels_retained_only_for_existing_pages(self):
        result = curate_form('9', definition([node(1)], pages=[{'id': 1, 'label': '<b>General</b>'}, {'id': 2, 'label': 'Hidden'}]))
        self.assertEqual(result['pages'], [{'id': 1, 'label': 'General'}])

    def test_page_label_media_retains_provenance(self):
        result = curate_form('9', definition([node(1)], pages=[{'id': 1, 'label': '<img src="data:image/png;base64,aGVsbG8=">'}]))
        self.assertEqual(len(result['media']), 1)
        snapshot_bytes(result)

    def test_forms_publication_preserves_content_and_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / 'submissions.json.gz').write_bytes(b'unchanged original content')
            (output / 'manifest.json').write_text(json.dumps({'files': {}, 'verification': {}}))
            defs = {'9': definition([node(1)])}
            publish_forms(output, defs, {}, '2026-10-12T00:00:00Z')
            first = (output / 'forms.json.gz').read_bytes()
            publish_forms(output, defs, {}, '2026-10-12T00:00:00Z')
            self.assertEqual(first, (output / 'forms.json.gz').read_bytes())
            self.assertEqual((output / 'submissions.json.gz').read_bytes(), b'unchanged original content')

    def test_actual_public_forms_match_all_captured_field_sets(self):
        folder = Path(__file__).parent / 'output'
        forms = json.loads(gzip.decompress((folder / 'forms.json.gz').read_bytes()))['forms']
        records = json.loads(gzip.decompress((folder / 'submissions.json.gz').read_bytes()))['records']
        by_id = {form['id']: form for form in forms}
        self.assertEqual(set(by_id), {record['formId'] for record in records})
        self.assertEqual(len(forms), 11)
        self.assertEqual(sum(len(form['nodes']) for form in forms), 134)
        for record in records:
            self.assertEqual({field['id'] for field in record['fields']},
                             {n['fieldId'] for n in by_id[record['formId']]['nodes'] if n['dynamic']})

    def test_actual_project_layout_preserves_label_and_static_group_sequence(self):
        folder = Path(__file__).parent / 'output'
        forms = json.loads(gzip.decompress((folder / 'forms.json.gz').read_bytes()))['forms']
        form = next(f for f in forms if f['id'] == '3')
        heading = next(n for n in form['nodes'] if n['fieldId'] == '37')
        self.assertEqual(heading['type'], 'label')
        self.assertTrue(heading['dynamic'])
        self.assertEqual(heading['fieldRank'], '8')
        self.assertEqual([n['semanticType'] for n in form['nodes'] if not n['dynamic']],
                         ['attachments', 'linked', 'spatial', 'permissions', 'parent'])


if __name__ == '__main__':
    unittest.main()
