#!/usr/bin/env python3
"""Separate one local WAV with the provisioned Demucs-MLX htdemucs weights."""

import os
import sys
import wave
from functools import partial
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch


def write_pcm16(path, audio, sample_rate, scale):
    import numpy as np

    pcm = np.clip(np.rint(audio.T * scale), -32768, 32767).astype("<i2")
    with path.open("xb") as file, wave.open(file, "wb") as output:
        output.setnchannels(audio.shape[0])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def main():
    source, directory, cache = map(Path, sys.argv[1:])
    os.environ["DEMUCS_MLX_CACHE_DIR"] = str(cache)
    os.environ["DEMUCS_MLX_NO_DOWNLOAD"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"
    if version("demucs-mlx") != "1.6.1":
        raise RuntimeError("The Companion separator requires demucs-mlx 1.6.1")

    import numpy as np
    from demucs_mlx import Separator
    from demucs_mlx.mlx_convert import load_mlx_model

    # The default loader can attempt Torch conversion after a cache miss in offline mode.
    local_model = partial(load_mlx_model, cache_dir=str(cache), auto_convert=False, verbose=False)
    with patch("demucs_mlx.model_converter.get_mlx_model", local_model):
        separator = Separator(model="htdemucs", seed=0)
    original, stems = separator.separate_audio_file(source)
    vocal = stems["vocals"]
    accompaniment = stems["drums"] + stems["bass"] + stems["other"]
    if any(track.shape != original.shape or not np.isfinite(track).all() for track in (vocal, accompaniment)):
        raise ValueError("Invalid separated audio")
    peak = max(np.max(np.abs(vocal)), np.max(np.abs(accompaniment)), 1.0)
    scale = 32767.0 / peak
    write_pcm16(directory / "vocal.wav", vocal, separator.samplerate, scale)
    write_pcm16(directory / "accompaniment.wav", accompaniment, separator.samplerate, scale)


if __name__ == "__main__":
    main()
