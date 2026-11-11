import argparse
import json
import os
import sys
import wave

from piper import PiperVoice


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    text = request["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > 1500:
        raise ValueError("Invalid text length")
    voice = PiperVoice.load(args.model)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(args.output, flags, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        with wave.open(output, "wb") as wav_file:
            voice.synthesize_wav(text, wav_file)
    with wave.open(args.output, "rb") as wav_file:
        frames = wav_file.getnframes()
        duration_ms = round(frames * 1000 / wav_file.getframerate())
        if frames <= 0 or wav_file.getnchannels() != 1 or wav_file.getsampwidth() != 2:
            raise ValueError("Voice produced invalid audio")
    print(json.dumps({"durationMs": duration_ms, "bytes": os.path.getsize(args.output)}))


if __name__ == "__main__":
    main()
