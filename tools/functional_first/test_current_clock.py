"""UNIT_ONLY current-job binding; no API request, runtime clock or device proof."""
import json, unittest
from pathlib import Path
from job_clock import derive

class CurrentClockIntegrationTests(unittest.TestCase):
 def sample(self, name):
  raw = json.dumps({'total_count': 1, 'jobs': [{'id': 9, 'name': name,
   'status': 'in_progress', 'run_id': 123, 'started_at': '2026-10-11T01:00:00Z'}]}).encode()
  url = 'https://api.github.com/repos/owner/repo/actions/runs/123/attempts/1/jobs?per_page=100'
  return raw, 'Sun, 11 Oct 2026 01:01:00 GMT', 'owner/repo', '123', 1, name, 100000000000, 101000000000, url, url
 def test_both_exact_current_matrix_job_names_bind(self):
  for suffix in ('35-r05', '36-r07'):
   name = 'shikuang-current-r9-functional-first-' + suffix
   with self.subTest(name=name):
    result = derive(*self.sample(name))
    self.assertEqual(result['job_name'], name)
    self.assertEqual(result['started_monotonic_ns'], 38000000000)
 def test_old_job_or_wrong_matrix_name_cannot_grant_budget(self):
  for name in ('shikuang-functional-first-35-r05',
   'shikuang-current-r9-functional-first-35-r06',
   'shikuang-current-r9-functional-first-36-r07-extra'):
   with self.subTest(name=name), self.assertRaises(ValueError): derive(*self.sample(name))
 def test_actual_workflow_clock_bytes_equal_current_module(self):
  root = Path(__file__).resolve().parents[2]
  workflow = (root / '.github/workflows/android-functional-first.yml').read_text()
  start = workflow.index('        #!/usr/bin/env python3\n')
  end = workflow.index('        PYCLOCK\n', start)
  inline = ''.join(line[8:] for line in workflow[start:end].splitlines(keepends=True))
  self.assertEqual(inline.encode(), (root / 'tools/functional_first/job_clock.py').read_bytes())
  self.assertIn('name: shikuang-current-r9-functional-first-${{ matrix.id }}', workflow)

if __name__ == '__main__': unittest.main()
