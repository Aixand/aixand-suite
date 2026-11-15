"""Small, CPU-only keyword model. No Whisper, Codex, or API key is needed."""
import hashlib
import os
from pathlib import Path
import tarfile
import tempfile
import urllib.request

MODEL = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{MODEL}.tar.bz2"
SHA256 = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
FILES = {"encoder": "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
         "decoder": "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
         "joiner": "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx", "tokens": "tokens.txt"}
KEYWORD_THRESHOLD = 0.25
TRAILING_BLANKS = 1
CONFIGURATION = "vox-wake-english-v2"
# Precomputed with this pinned model's bpe.model. Runtime needs no tokenizer.
# A single trailing blank also accepts 'Hey Vox, can you help me?' naturally.
KEYWORDS = """▁HE Y ▁ VO X @wake
▁ VO X ▁MU TE @mute_microphone
▁ VO X ▁UN M U TE @unmute_microphone
▁ VO X ▁EN D @end_call
▁ VO X ▁EN D ▁CALL @end_call
▁ VO X ▁GO ▁OF F LINE @go_offline
"""


def model_directory():
    cache = Path(os.environ.get("VOX_WAKE_MODEL_DIR") or Path.home() / ".cache/aixand/vox/wake").expanduser()
    # Keep tokens and weights from different model revisions separate, including
    # when an older worker is still running during an upgrade.
    return cache / MODEL


def prepare_model():
    root = model_directory()
    root.mkdir(parents=True, exist_ok=True)
    if not all((root / name).is_file() for name in FILES.values()):
        with tempfile.TemporaryDirectory(dir=root) as temp:
            archive = Path(temp) / "model.tar.bz2"
            with urllib.request.urlopen(URL, timeout=60) as response, archive.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    if output.tell() > 64 * 1024 * 1024:
                        raise ValueError("Wake model download exceeded its limit.")
            if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
                raise ValueError("Wake model checksum did not match.")
            with tarfile.open(archive) as bundle:
                for name in FILES.values():
                    member = bundle.getmember(f"{MODEL}/{name}")
                    if not member.isfile() or member.size > 16 * 1024 * 1024:
                        raise ValueError("Invalid wake model archive.")
                    candidate = Path(temp) / name
                    candidate.write_bytes(bundle.extractfile(member).read())
                    candidate.replace(root / name)
    (root / "vox-keywords.txt").write_text(KEYWORDS, encoding="utf-8")
    return root


class KeywordDetector:
    def __init__(self):
        import sherpa_onnx
        root = prepare_model()
        self.spotter = sherpa_onnx.KeywordSpotter(**{key: str(root / name) for key, name in FILES.items()},
            keywords_file=str(root / "vox-keywords.txt"), num_threads=1,
            keywords_threshold=KEYWORD_THRESHOLD, num_trailing_blanks=TRAILING_BLANKS, provider="cpu")
        self.stream = self.spotter.create_stream()

    def feed(self, samples, sample_rate=16000):
        self.stream.accept_waveform(sample_rate, samples)
        found = []
        while self.spotter.is_ready(self.stream):
            self.spotter.decode_stream(self.stream)
            keyword = self.spotter.get_result(self.stream)
            if keyword:
                self.spotter.reset_stream(self.stream)
                found.append(keyword)
        return found
