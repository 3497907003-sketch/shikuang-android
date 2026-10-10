"""Scientific/source-boundary tests; arithmetic fixtures are not mineral labels."""
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
from annotate_crystal_systems import classify, compile_annotations


class CrystalSystemTests(unittest.TestCase):
    def fixture(self, symbol='32', standard='32'):
        raw=b'%PDF-unit-test-only-not-a-scientific-source'
        url='https://www.handbookofmineralogy.org/pdfs/quartz.pdf'
        fact={'value':'Hexagonal', 'status':'verified', 'source_url':url}
        knowledge={'quartz':{'verified_properties':{'crystal_system':fact}}}
        row={'legacy_keys':['quartz'], 'source_url':url, 'source_page':1, 'source_pdf_sha256':hashlib.sha256(raw).hexdigest(), 'source_original_value':'Hexagonal', 'visual_review':{'reviewer':'unit-fixture-not-real-review','page':1,'render_sha256':'a'*64}, 'point_groups':[{'source_symbol':symbol,'standard_symbol':standard,'condition_zh':''}]}
        return raw,knowledge,{'schema_version':1, 'classification_sources':[{},{}], 'records':[row]}

    def test_iuc_point_group_families_are_not_classified_by_first_digit(self):
        for group in ['3','−3','32','3m','−3 2/m']:
            self.assertEqual(classify(group)[0],'trigonal')
        for group in ['6','−6','6/m','622','6mm','−6m2','6/m 2/m 2/m']:
            self.assertEqual(classify(group)[0],'hexagonal')
        self.assertEqual(classify('23')[0],'cubic')
        self.assertEqual(classify('2/m')[0],'monoclinic')
        with self.assertRaises(ValueError): classify('3 or maybe 6')

    def test_missing_overbar_cannot_be_reconstructed_as_a_normalization(self):
        _,kb,reviewed=self.fixture('3m','-3m')
        with self.assertRaisesRegex(ValueError,'changed symbol'):compile_annotations(reviewed,kb)

    def test_changed_pdf_and_changed_field_require_new_review(self):
        raw,kb,reviewed=self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory);(p/'quartz.pdf').write_bytes(raw)
            original=copy.deepcopy(kb);self.assertEqual(compile_annotations(reviewed,kb,p)['records'][0]['point_groups'][0]['crystal_system'],'trigonal');self.assertEqual(kb,original)
            (p/'quartz.pdf').write_bytes(raw+b'changed')
            with self.assertRaisesRegex(ValueError,'repeat visual review'):compile_annotations(reviewed,kb,p)
        kb['quartz']['verified_properties']['crystal_system']['value']='Hexagonal or monoclinic'
        with self.assertRaisesRegex(ValueError,'field changed'):compile_annotations(reviewed,kb)

    def test_polytypes_keep_conditions_and_never_choose_one_current_sample_phase(self):
        _,kb,r=self.fixture('6/m 2/m 2/m','6/mmm');r['records'][0]['point_groups'][0]['condition_zh']='2H多型'
        r['records'][0]['point_groups'].append({'source_symbol':'3m','standard_symbol':'3m','condition_zh':'3R多型'})
        value=compile_annotations(r,kb)['records'][0]
        self.assertEqual(value['status'],'conditional');self.assertIn('2H多型',value['display_zh']);self.assertIn('3R多型',value['display_zh'])

    def test_pseudohexagonal_fields_are_not_silently_reclassified(self):
        _,kb,r=self.fixture();kb['aragonite']={'verified_properties':{'crystal_system':{'value':'Orthorhombic, pseudohexagonal'}}}
        result=compile_annotations(r,kb)
        self.assertEqual(result['counts']['legacy_labels'],1)
        self.assertNotIn('aragonite',result['records'][0]['legacy_keys'])


if __name__=='__main__':unittest.main()
