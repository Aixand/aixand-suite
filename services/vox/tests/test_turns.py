import asyncio
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from aixand_vox.turns import VoiceTurnBuffer


class VoiceTurnTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.session = SimpleNamespace(voice_started=Mock(), preview_voice=Mock(), voice_finished=Mock())
        self.turns = VoiceTurnBuffer(self.session, pause_seconds=0.04)

    async def asyncTearDown(self):
        await self.turns.close()

    def segment(self, identifier, text):
        self.turns.queued(identifier)
        self.turns.transcribed(identifier, text)
        self.turns.finished(identifier)

    async def test_paused_correction_is_one_full_instruction_and_one_user_bubble(self):
        self.turns.started()
        draft = self.turns.draft_id
        self.turns.stopped()
        self.segment(1, "Check project A")
        await asyncio.sleep(0.01)
        self.session.voice_finished.assert_not_called()
        self.turns.started()
        self.assertEqual(self.turns.draft_id, draft)
        self.turns.stopped()
        self.segment(2, "actually project B, only the frontend")
        await asyncio.sleep(0.06)
        self.session.voice_finished.assert_called_once_with(
            "Check project A actually project B, only the frontend", draft)
        self.assertEqual({call.args[0] for call in self.session.preview_voice.call_args_list}, {draft})

    async def test_silence_does_not_send_a_partial_instruction_while_stt_is_pending(self):
        self.turns.started()
        self.turns.stopped()
        self.turns.queued(1)
        self.turns.transcribed(1, "first part")
        await asyncio.sleep(0.06)
        self.session.voice_finished.assert_not_called()
        self.turns.started()
        self.turns.stopped()
        self.turns.queued(2)
        self.turns.finished(1)
        await asyncio.sleep(0.06)
        self.session.voice_finished.assert_not_called()
        self.turns.transcribed(2, "second part")
        self.turns.finished(2)
        await asyncio.sleep(0.01)
        self.session.voice_finished.assert_called_once()
        self.assertEqual(self.session.voice_finished.call_args.args[0], "first part second part")

    async def test_resumed_speech_blocks_submission_even_when_old_stt_arrives_late(self):
        self.turns.started()
        self.turns.stopped()
        self.turns.queued(1)
        self.turns.started()
        self.turns.transcribed(1, "first part")
        self.turns.finished(1)
        await asyncio.sleep(0.06)
        self.session.voice_finished.assert_not_called()
        self.turns.stopped()
        self.segment(2, "continued")
        await asyncio.sleep(0.06)
        self.assertEqual(self.session.voice_finished.call_args.args[0], "first part continued")

    async def test_turn_deadline_accounts_for_vad_start_confirmation(self):
        self.turns.started(start_confirmation=0.04)
        self.turns.stopped(vad_silence=0.02)
        self.segment(1, "First part")
        await asyncio.sleep(0.04)
        self.session.voice_finished.assert_not_called()
        self.turns.started(start_confirmation=0.04)
        self.turns.stopped(vad_silence=0.02)
        self.segment(2, "Continuation")
        await asyncio.sleep(0.08)
        self.assertEqual(self.session.voice_finished.call_args.args[0], "First part Continuation")

    async def test_empty_segment_releases_listening_without_an_instruction(self):
        self.turns.started()
        self.turns.stopped()
        self.segment(1, " ")
        await asyncio.sleep(0.06)
        self.session.voice_finished.assert_called_once()
        self.assertEqual(self.session.voice_finished.call_args.args[0], "")
        self.session.preview_voice.assert_not_called()

    async def test_a_failed_segment_does_not_dispatch_an_incomplete_instruction(self):
        self.turns.started()
        self.turns.stopped()
        self.segment(1, "Inspect the")
        self.turns.queued(2)
        self.turns.finished(2, failed=True)
        await asyncio.sleep(0.06)
        self.assertEqual(self.session.voice_finished.call_args.args[0], "")

    async def test_closing_capture_discards_the_pending_draft_and_late_results(self):
        self.turns.started()
        self.turns.stopped()
        self.segment(1, "Do not dispatch this draft")
        await self.turns.close()
        self.turns.transcribed(1, "late text")
        self.turns.finished(1)
        await asyncio.sleep(0.06)
        self.session.voice_finished.assert_called_once_with("", None)

    async def test_long_transcripts_remain_bounded(self):
        self.turns.started()
        self.turns.stopped()
        self.segment(1, "x" * 20000)
        self.segment(2, "y" * 20000)
        self.assertEqual(len(self.turns.text), 16000)
        await asyncio.sleep(0.06)
        self.assertEqual(len(self.session.voice_finished.call_args.args[0]), 16000)
