import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyApproval } from '../operator-approval.mjs';

test('missing approval is rejected without inspecting or promoting any job', async () => {
  await assert.rejects(verifyApproval({root:'/nonexistent',stateDir:'/nonexistent',id:'bad',
    envelope:null,trustedOperators:{}}), /invalid signed approval/);
});
