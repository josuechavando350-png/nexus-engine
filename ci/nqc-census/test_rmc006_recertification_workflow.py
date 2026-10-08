"""PR-safe tests of the actual workflow dispatch decision script."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

WORKFLOW = Path(__file__).resolve().parents[2]/'.github/workflows/nqc-census-aave-discovery.yml'


class WorkflowBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()
        section = self.text.split('      - name: Reject non-seed dispatch inputs\n', 1)[1]
        script = section.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
        self.script = '\n'.join(line[10:] for line in script.splitlines())

    def decision(self, event, run='', artifact='', digest=''):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)/'output'
            env = dict(os.environ, EVENT_NAME=event, SOURCE_RUN_ID=run, SOURCE_ARTIFACT_ID=artifact,
                       SOURCE_ZIP_SHA256=digest, GITHUB_OUTPUT=str(output))
            result = subprocess.run(['bash', '-c', self.script], env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
            return result.returncode, output.read_text() if output.exists() else '', result.stdout

    def test_pull_request_cannot_recertify(self):
        status, output, message = self.decision('pull_request')
        self.assertEqual(status, 0)
        self.assertEqual(output, 'verify=false\n')
        self.assertIn('certifies nothing', message)

    def test_blank_and_partial_dispatch_fail_closed(self):
        for values in [('', '', ''), ('36820687233', '', ''), ('wrong', '11143129177', 'wrong')]:
            status, output, _ = self.decision('workflow_dispatch', *values)
            self.assertNotEqual(status, 0)
            self.assertNotIn('verify=true', output)

    def test_exact_dispatch_is_seed_only(self):
        status, output, _ = self.decision('workflow_dispatch', '36820687233', '11143129177',
            '1cdb46fca52ebf1e0e2094b1c14b19384ecb7beceb50229b967592ab7a0308b4')
        self.assertEqual(status, 0)
        self.assertEqual(output, 'verify=true\n')

    def test_unknown_event_cannot_recertify(self):
        self.assertNotEqual(self.decision('push')[0], 0)

    def test_no_acquisition_or_old_default_in_workflow(self):
        self.assertNotIn('target/release/nqc-rmc006-aave-current ', self.text)
        self.assertNotIn('target/release/nqc-rmc006-aave-history ', self.text)
        self.assertNotIn('25437474', self.text)
        self.assertNotIn('nqc-census-public-rpc', self.text)
        self.assertIn('sudo unshare --net --mount', self.text)
        self.assertIn('needs: validate', self.text)
        self.assertIn('RECERTIFICATION_BASE: 3b23804a46bfcc730d57784fb95a349e6e6e726b', self.text)
        self.assertIn('git merge-base --is-ancestor "$RECERTIFICATION_BASE" HEAD', self.text)
        self.assertIn('git merge-base --is-ancestor "$RMC003_2_AUTHORITY" HEAD', self.text)


if __name__ == '__main__':
    unittest.main()
