"""Explicit call commands run locally, without a Codex turn or Suite mutation."""
import re

ACTIONS = {"mute_microphone", "unmute_microphone", "mute_speaker", "unmute_speaker", "end_call", "go_offline"}


def call_command(text):
    words = " ".join(re.sub(r"[^a-z\s]", " ", text.casefold()).split())
    words = re.sub(r"^(?:please |could you |can you |would you )", "", words)
    words = re.sub(r"(?: please| for me)$", "", words)
    prefixed = bool(re.match(r"^(?:hey )?vox\b", words))
    words = re.sub(r"^(?:hey )?vox\s*", "", words)
    commands = {
        "end": "end_call", "end call": "end_call", "end the call": "end_call", "hang up": "end_call",
        "disconnect": "end_call", "go offline": "go_offline", "offline": "go_offline",
        "mute": "mute_microphone", "mute my microphone": "mute_microphone", "mute the microphone": "mute_microphone",
        "unmute": "unmute_microphone", "unmute my microphone": "unmute_microphone", "unmute the microphone": "unmute_microphone",
        "mute speaker": "mute_speaker", "mute your voice": "mute_speaker", "stop speaking": "mute_speaker",
        "unmute speaker": "unmute_speaker", "unmute your voice": "unmute_speaker",
    }
    if not prefixed and words in {"end", "offline", "mute", "unmute", "disconnect"}:
        return None
    return commands.get(words)
