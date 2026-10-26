import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from agent_manager import Manager
from agent_manager.management import delete_profile
from orchestration_mcp.state import ChatState


class IdentityReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='suite-identity-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        config = self.root/'config.toml'
        config.write_text('[providers.codex]\nexecutable="/bin/true"\nnative_home='+json.dumps(str(self.root/'native'))+'\n')
        self.manager = Manager('codex', config=config, root=self.root/'manager')
        self.manager.new_profile('work')
        self.manager.write_auth(self.manager.auth_home('personal'), {'auth.json':b'{}'})
        state = self.manager.state()
        state['auths'].append('personal'); state['agents']['work'] = 'personal'
        self.manager.save(state)
        state = self.manager.state()
        self.state = ChatState(self.root/'chats.sqlite')
        self.db = self.state.connect(True)
        self.addCleanup(self.db.close)
        self.chat = dict(id='chat', provider='codex', profile='work', auth='personal',
            profileId=state['profile_ids']['work'], authId=state['auth_ids']['personal'],
            homeId=state['home_ids'][str(self.manager.home('work'))], threadId=str(uuid.uuid4()),
            runId='original', createdAt=0, updatedAt=123, revision=0, status='completed', items=[{'id':'history'}])
        with self.db:
            self.db.execute('INSERT INTO chats VALUES (?,?)', ('chat', json.dumps(self.chat)))
        self.state.reconcile_identities(self.manager)

    def get(self):
        return self.state.get('chat')

    def test_cli_rename_while_bridge_is_offline_is_replayed_once(self):
        self.manager.rename('work', 'renamed')
        self.assertEqual(self.get()['profile'], 'work')
        restarted = ChatState(self.state.path)
        restarted.reconcile_identities(self.manager)
        result = self.get()
        self.assertEqual(result['profile'], 'renamed')
        self.assertEqual(result['profileId'], self.chat['profileId'])
        self.assertEqual(result['threadId'], self.chat['threadId'])
        self.assertEqual(result['items'], self.chat['items'])
        self.assertEqual(result['updatedAt'], 123)
        restarted.reconcile_identities(self.manager)
        self.assertEqual(self.get(), result)

    def test_auth_rename_follows_identity_and_preserves_account_binding(self):
        self.manager.rename_auth('personal', 'company')
        self.state.reconcile_identities(self.manager)
        self.assertEqual(self.get()['auth'], 'company')
        self.assertEqual(self.get()['authId'], self.chat['authId'])
        self.assertEqual(self.get()['runId'], 'original')

    def test_deleted_and_recreated_name_does_not_retarget_a_conversation(self):
        delete_profile(self.manager, 'work')
        self.manager.new_profile('work')
        self.state.reconcile_identities(self.manager)
        result = self.get()
        self.assertEqual(result['identityState'], 'needs_attention')
        self.assertTrue(result['profileDeleted'])
        self.assertNotEqual(self.manager.state()['profile_ids']['work'], result['profileId'])

    def test_projection_and_event_cursor_roll_back_together(self):
        before = list(self.db.execute('SELECT * FROM identity_cursors'))
        self.manager.rename('work', 'renamed')
        with self.db:
            self.db.execute("CREATE TRIGGER reject_identity BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT,'fixture crash'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.state.reconcile_identities(self.manager)
        self.assertEqual([tuple(row) for row in self.db.execute('SELECT * FROM identity_cursors')], [tuple(row) for row in before])
        self.assertEqual(self.get()['profile'], 'work')
        with self.db:
            self.db.execute('DROP TRIGGER reject_identity')
        self.state.reconcile_identities(self.manager)
        self.assertEqual(self.get()['profile'], 'renamed')

    def test_unproven_legacy_name_is_not_bound_to_the_current_profile(self):
        row = {key:value for key,value in self.chat.items() if key not in ('profileId','authId','homeId')}
        with self.db:
            self.db.execute('UPDATE chats SET record=? WHERE id=?', (json.dumps(row), 'chat'))
        self.state.reconcile_identities(self.manager)
        self.assertEqual(self.get()['identityState'], 'needs_attention')
        self.assertNotIn('profileId', self.get())

    def test_recovery_readiness_does_not_claim_a_conversation_connected(self):
        from agent_manager.auth_recovery import request
        state = self.manager.state()
        operation = request(self.manager, state, 'work', self.manager.home('work'), 'personal')
        operation.update(phase='ready')
        self.manager.save(state)
        self.state.reconcile_identities(self.manager)
        self.assertEqual(self.get()['connectionState'], 'ready_to_reconnect')
        self.assertEqual(self.get()['status'], 'completed')
        self.assertEqual(self.get()['runId'], 'original')
