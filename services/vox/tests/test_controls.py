import unittest
from aixand_vox.controls import call_command


class ControlTests(unittest.TestCase):
    def test_direct_commands_and_natural_call_requests(self):
        for text, action in [("Vox, mute.", "mute_microphone"), ("Vox unmute", "unmute_microphone"),
            ("Vox, end", "end_call"), ("Please end the call", "end_call"),
            ("Can you hang up please?", "end_call"), ("Vox go offline", "go_offline"),
            ("Please mute my microphone", "mute_microphone"), ("Vox, stop speaking", "mute_speaker")]:
            with self.subTest(text=text): self.assertEqual(call_command(text), action)

    def test_mentions_inside_ordinary_messages_do_not_execute_commands(self):
        for text in ["Explain the Vox mute command", "Investigate why Vox end does not work",
                     "Do not mute my microphone", "Does going offline stop my investigation?", "end", "mute"]:
            with self.subTest(text=text): self.assertIsNone(call_command(text))
