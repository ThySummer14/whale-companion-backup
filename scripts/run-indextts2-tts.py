#!/usr/bin/env python3
"""Render one speech clip with a prepared local MLX IndexTTS 2.0 voice."""

import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import sys
import warnings

SAMPLE_RATE = 22050
MAX_CHARS = 480
STYLES = {"reference": (None, 0.6), "happy": ("happy", 0.75), "sad": ("sad", 0.75)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--style", choices=STYLES, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = json.loads(sys.stdin.read(16385))
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text.encode("utf-16-le")) > 2 * MAX_CHARS:
        parser.error("Expected non-empty text within the speech length limit")
    speaker = args.model_dir / "speaker.npz"
    if not speaker.is_file():
        parser.error("Prepared speaker cache is missing")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TORCH_FORCE_WEIGHTS_ONLY_LOAD="1")
    emotion, strength = STYLES[args.style]
    with redirect_stdout(sys.stderr):
        import numpy as np
        import soundfile
        from mlx_indextts import IndexTTSv2

        warnings.filterwarnings("error", message="Generation stopped due to exceeding max_mel_tokens")
        warnings.filterwarnings("error", message="No mel tokens generated for segment")
        model = IndexTTSv2(str(args.model_dir), device="mps", quantize_bits=4, memory_limit_gb=8)
        audio = model.generate(text.strip(), str(speaker), emotion=emotion, emo_alpha=strength,
                               max_text_tokens_per_segment=48, seed=42)
        if (audio.ndim != 1 or not 0 < audio.size <= 180 * SAMPLE_RATE or not np.isfinite(audio).all()
                or np.max(np.abs(audio)) < 0.01):
            raise ValueError("Invalid or silent IndexTTS audio")
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as target:
            soundfile.write(target, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    print(json.dumps({"durationMs": round(audio.size * 1000 / SAMPLE_RATE), "bytes": args.output.stat().st_size}))


if __name__ == "__main__":
    main()
