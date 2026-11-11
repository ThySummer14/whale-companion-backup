#!/usr/bin/env python3
"""Render a Companion score with a local SoulX-Singer model."""

import argparse
import json
import os
import re
import runpy
import sys
from fractions import Fraction
from pathlib import Path


HOP_MS = 20  # The supported 24 kHz / 480 sample SoulX-Singer configuration.
SAMPLE_RATE = 24_000
MIN_PHRASE_MS = 4_000
MAX_PHRASE_MS = 24_000
MAX_SCORE_MS = 180_000
MAX_SCORE_ROWS = 512
MAX_PHRASE_ROWS = 64
MAX_PHRASE_DRIFT_FRAMES = SAMPLE_RATE * 150 // 1_000
PAUSE = "<SP>"
LYRIC = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def phrase_ranges(score, quarter_beats, note_type):
    note_count = len(note_type)
    if "phrases" not in score:
        phrases = [{"start": 0, "end": note_count, "startBeats": 0, "endBeats": quarter_beats[-1] / 4}]
    else:
        phrases = score["phrases"]
    if not isinstance(phrases, list) or not 1 <= len(phrases) <= MAX_SCORE_MS // MIN_PHRASE_MS:
        raise ValueError("Invalid score phrase count")

    bpm = score["bpm"]
    cursor = 0
    ranges = []
    for phrase in phrases:
        if not isinstance(phrase, dict) or set(phrase) != {"start", "end", "startBeats", "endBeats"}:
            raise ValueError("Invalid score phrase")
        start, end = phrase["start"], phrase["end"]
        if type(start) is not int or type(end) is not int or start != cursor or not start < end <= note_count:
            raise ValueError("Score phrases must cover adjacent note ranges")
        for name, row in (("startBeats", start), ("endBeats", end)):
            beats = phrase[name]
            if type(beats) not in (int, float) or beats != quarter_beats[row] / 4:
                raise ValueError("Score phrase offset does not match the notes")
        duration = Fraction((quarter_beats[end] - quarter_beats[start]) * 60_000, 4 * bpm)
        if not MIN_PHRASE_MS <= duration <= MAX_PHRASE_MS or end - start > MAX_PHRASE_ROWS:
            raise ValueError("Each score phrase must have at most 64 rows and run for 4–24 seconds")
        if note_type[start] == 3 or note_type[start:end].count(2) < 2:
            raise ValueError("Each score phrase needs two syllables and must not split a continued syllable")
        ranges.append((start, end))
        cursor = end
    if cursor != note_count:
        raise ValueError("Score phrases do not cover all notes")
    return ranges


def score_metadata(score, phoneset, pronounce):
    bpm = score["bpm"]
    notes = score["notes"]
    if type(bpm) is not int or not 60 <= bpm <= 180 or not isinstance(notes, list) or not 2 <= len(notes) <= MAX_SCORE_ROWS:
        raise ValueError("Score tempo or note count is out of range")

    quarter_beats = [0]
    boundaries_ms = [0]
    note_text = []
    note_pitch = []
    note_type = []
    syllables = []
    syllable_index = []
    previous_lyric = None
    for note in notes:
        beats = note["beats"]
        if type(beats) not in (int, float) or not 0.25 <= beats <= 8 or beats * 4 % 1:
            raise ValueError("A note must use whole quarter beats within the supported range")
        quarter_beats.append(quarter_beats[-1] + int(beats * 4))
        hops = round(Fraction(quarter_beats[-1] * 60_000, 4 * bpm * HOP_MS))
        boundaries_ms.append(hops * HOP_MS)

        midi = note["midi"]
        lyric = note.get("lyric")
        if midi is None and lyric is None:
            previous_lyric = None
            note_text.append(PAUSE)
            note_pitch.append(0)
            note_type.append(1)
            syllable_index.append(None)
            continue
        if (type(midi) is not int or not 48 <= midi <= 84 or not isinstance(lyric, str)
                or (lyric != "_" and not LYRIC.fullmatch(lyric))):
            raise ValueError("A sung note must have a supported MIDI pitch and one lyric syllable")
        if lyric == "_":
            if previous_lyric is None:
                raise ValueError("A continued syllable must follow a sung note")
            note_type.append(3)
        else:
            previous_lyric = lyric
            syllables.append(lyric)
            note_type.append(2)
        note_text.append(previous_lyric)
        note_pitch.append(midi)
        syllable_index.append(len(syllables) - 1)

    duration = Fraction(quarter_beats[-1] * 60_000, 4 * bpm)
    if not MIN_PHRASE_MS <= duration <= MAX_SCORE_MS:
        raise ValueError("Score duration must be 4–180 seconds")
    ranges = phrase_ranges(score, quarter_beats, note_type)
    phones = ["zh_" + phone for phone in pronounce("".join(syllables), tone=True, char_split=False)]
    if len(phones) != len(syllables) or PAUSE not in phoneset or any(phone not in phoneset for phone in phones):
        raise ValueError("Score contains a Mandarin syllable outside the SoulX-Singer phone set")

    metadata = []
    for index, (start, end) in enumerate(ranges):
        durations = (boundaries_ms[row + 1] - boundaries_ms[row] for row in range(start, end))
        metadata.append({
            "index": "companion-score" if len(ranges) == 1 else f"companion-score-{index + 1}",
            "language": "Mandarin",
            "time": [boundaries_ms[start], boundaries_ms[end]],
            "duration": " ".join(f"{milliseconds / 1_000:.2f}" for milliseconds in durations),
            "text": " ".join(note_text[start:end]),
            "phoneme": " ".join(PAUSE if index is None else phones[index] for index in syllable_index[start:end]),
            "note_pitch": " ".join(map(str, note_pitch[start:end])),
            "note_type": " ".join(map(str, note_type[start:end])),
            "f0": "",
        })
    return metadata


def stitch_phrase(output, start, end, audio):
    import numpy as np

    if audio.ndim != 1 or abs(len(audio) - (end - start)) > MAX_PHRASE_DRIFT_FRAMES:
        raise ValueError("SoulX-Singer phrase length differs from the score")
    audio = audio[:end - start]
    if not np.isfinite(audio).all() or np.max(np.abs(audio)) < 1 / 32_768:
        raise ValueError("SoulX-Singer phrase contains no valid audible PCM")
    output[start:start + len(audio)] = audio


def render_long_score(args, script, config_path, phoneset, output, metadata):
    import numpy as np
    import soundfile as sf
    import torch

    upstream = runpy.run_path(str(script))
    config = upstream["load_config"](str(config_path))
    if config.audio.sample_rate != SAMPLE_RATE or config.audio.hop_size != SAMPLE_RATE * HOP_MS // 1_000:
        raise ValueError("SoulX-Singer score rendering requires 24 kHz audio with a 20 ms hop")
    processor = upstream["DataProcessor"](
        hop_size=config.audio.hop_size, sample_rate=SAMPLE_RATE, phoneset_path=str(phoneset), device=args.device,
    )
    prompt_metadata = json.loads(args.prompt_metadata.read_text(encoding="utf-8"))
    if not prompt_metadata:
        raise ValueError("Prompt metadata is empty")
    prompt = processor.process(prompt_metadata[0], str(args.prompt_wav))
    model = upstream["build_model"](str(args.model), config, device=args.device)
    merged = np.zeros(metadata[-1]["time"][1] * SAMPLE_RATE // 1_000, dtype=np.float32)
    with torch.no_grad():
        for phrase in metadata:
            start, end = (milliseconds * SAMPLE_RATE // 1_000 for milliseconds in phrase["time"])
            target = processor.process(phrase, None)
            audio = model.infer(
                {"prompt": prompt, "target": target}, n_steps=config.infer.n_steps, cfg=config.infer.cfg, control="score",
            ).squeeze().cpu().numpy()
            stitch_phrase(merged, start, end, audio)
    sf.write(output / "generated.wav", merged, SAMPLE_RATE, subtype="PCM_16")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("model", type=Path)
    parser.add_argument("prompt_wav", type=Path)
    parser.add_argument("prompt_metadata", type=Path)
    parser.add_argument("score", type=Path)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("device", choices=("mps", "cpu"))
    args = parser.parse_args()
    args.model = args.model.resolve()
    args.prompt_wav = args.prompt_wav.resolve()
    args.prompt_metadata = args.prompt_metadata.resolve()

    sys.dont_write_bytecode = True
    from g2pM import G2pM

    repo = args.repo.resolve()
    phoneset = repo / "soulxsinger/utils/phoneme/phone_set.json"
    config = repo / "soulxsinger/config/soulxsinger.yaml"
    output = args.output_directory.resolve()
    target_metadata = output / "target-score.json"
    score = json.loads(args.score.read_text(encoding="utf-8"))
    metadata = score_metadata(score, set(json.loads(phoneset.read_text(encoding="utf-8"))), G2pM())
    with target_metadata.open("x", encoding="utf-8") as stream:
        json.dump(metadata, stream, ensure_ascii=False)

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("HF_HOME", str(output / "hf"))
    if args.device == "mps":
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    script = repo / "cli/inference.py"
    os.chdir(repo)
    sys.path.insert(0, str(repo))
    if len(metadata) > 1:
        render_long_score(args, script, config, phoneset, output, metadata)
        return
    sys.argv = [
        str(script),
        "--device", args.device,
        "--model_path", str(args.model),
        "--config", str(config),
        "--prompt_wav_path", str(args.prompt_wav),
        "--prompt_metadata_path", str(args.prompt_metadata),
        "--target_metadata_path", str(target_metadata),
        "--phoneset_path", str(phoneset),
        "--save_dir", str(output),
        "--control", "score",
    ]
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
