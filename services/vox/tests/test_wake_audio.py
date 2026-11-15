"""Opt-in acoustic regression tests using local models, without Codex or capture."""
import os
import unittest

import av
import numpy as np


@unittest.skipUnless(os.environ.get("VOX_TEST_WAKE_AUDIO") == "1", "Set VOX_TEST_WAKE_AUDIO=1 with prepared local models")
class WakeAudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from pipecat.services.kokoro.tts import KokoroTTSService
        from aixand_vox.wake_model import KeywordDetector
        cls.tts = KokoroTTSService(settings=KokoroTTSService.Settings(voice="af_heart"))
        cls.detector = KeywordDetector()
        cls.audio_cache = {}

    def audio(self, voice, phrase):
        key = (voice, phrase)
        if key not in self.audio_cache:
            audio, rate = self.tts._kokoro.create(phrase, voice=voice, speed=1.0,
                lang="en-gb" if voice.startswith("b") else "en-us")
            pcm = np.clip(audio * 32768, -32768, 32767).astype(np.int16)
            frame = av.AudioFrame.from_ndarray(pcm[None, :], format="s16", layout="mono")
            frame.sample_rate = rate
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            frames = resampler.resample(frame) + resampler.resample(None)
            self.audio_cache[key] = np.concatenate([frame.to_ndarray().ravel() for frame in frames]).astype(np.float32) / 32768
        return self.audio_cache[key]

    def detect(self, audio, gain=1.0, noise=0.0):
        samples = np.concatenate([np.zeros(16000), audio * gain, np.zeros(16000)]).astype(np.float32)
        if noise:
            samples += np.random.default_rng(42).normal(0, noise, len(samples)).astype(np.float32)
        self.detector.stream = self.detector.spotter.create_stream()
        found = []
        for offset in range(0, len(samples), 320):
            found.extend(self.detector.feed(samples[offset:offset + 320]))
        return found

    def test_six_voices_wake_without_a_pause_and_control_the_call(self):
        phrases = [("Hey Vox", "wake"), ("Hey Vox, can you help me?", "wake"),
            ("Vox mute", "mute_microphone"), ("Vox unmute", "unmute_microphone"),
            ("Vox end", "end_call"), ("Vox go offline", "go_offline")]
        for voice in ("af_heart", "am_adam", "am_michael", "af_bella", "bf_emma", "bm_george"):
            for phrase, expected in phrases:
                with self.subTest(voice=voice, phrase=phrase):
                    self.assertEqual(self.detect(self.audio(voice, phrase)), [expected])

    def test_similar_words_and_ordinary_speech_do_not_trigger_controls(self):
        phrases = ("Hey folks", "Hey fox", "Hey box", "How is your day?",
            "Open the next window please", "The voice command failed again.")
        for voice in ("af_heart", "am_adam", "am_michael", "af_bella", "bf_emma", "bm_george"):
            for phrase in phrases:
                with self.subTest(voice=voice, phrase=phrase):
                    self.assertEqual(self.detect(self.audio(voice, phrase)), [])

    def test_quiet_voice_with_background_noise_can_wake_and_unmute(self):
        for voice in ("af_heart", "am_michael", "bm_george"):
            for phrase, expected in (("Hey Vox", "wake"), ("Vox unmute", "unmute_microphone")):
                with self.subTest(voice=voice, phrase=phrase):
                    self.assertEqual(self.detect(self.audio(voice, phrase), gain=0.25, noise=0.0008), [expected])


if __name__ == "__main__":
    unittest.main()
