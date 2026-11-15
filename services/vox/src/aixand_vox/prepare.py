"""Download and warm local speech models before accepting microphone requests."""


def main():
    from .speech import speech_services

    print("Preparing local Whisper and Kokoro models…", flush=True)
    speech_services()
    from .wake_model import prepare_model
    print("Preparing the lightweight Hey Vox keyword model…", flush=True)
    prepare_model()
    print("Vox speech models are ready.", flush=True)


if __name__ == "__main__":
    main()
