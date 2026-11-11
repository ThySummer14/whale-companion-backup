"""Focused checks for the local SoulX score adapter."""

import importlib.util
import json
import sys
import tempfile
import unittest
from contextlib import nullcontext
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("soulx_score", Path(__file__).with_name("run-soulx-score.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


PHONESET = {"<SP>", "zh_wei1", "zh_guang1"}


def pronounce(text, *, tone, char_split):
    if not tone or char_split:
        raise AssertionError("Unexpected Mandarin pronunciation mode")
    return [{"微": "wei1", "光": "guang1"}[character] for character in text]


def short_score():
    return {
        "bpm": 120,
        "notes": [
            {"midi": 60, "beats": 1, "lyric": "微"},
            {"midi": 62, "beats": 1, "lyric": "_"},
            {"midi": None, "beats": 1},
            {"midi": 64, "beats": 5, "lyric": "光"},
        ],
    }


def long_score():
    notes = short_score()["notes"]
    return {
        "bpm": 113,
        "notes": notes * 7,
        "phrases": [
            {"start": i * 4, "end": (i + 1) * 4, "startBeats": i * 8, "endBeats": (i + 1) * 8}
            for i in range(7)
        ],
    }


class ScoreMetadataTests(unittest.TestCase):
    def test_legacy_short_score_keeps_metadata(self):
        self.assertEqual(worker.score_metadata(short_score(), PHONESET, pronounce), [{
            "index": "companion-score",
            "language": "Mandarin",
            "time": [0, 4000],
            "duration": "0.50 0.50 0.50 2.50",
            "text": "微 微 <SP> 光",
            "phoneme": "zh_wei1 zh_wei1 <SP> zh_guang1",
            "note_pitch": "60 62 0 64",
            "note_type": "2 3 1 2",
            "f0": "",
        }])

    def test_batch_uses_absolute_hop_rounding_and_keeps_all_lyrics(self):
        metadata = worker.score_metadata(long_score(), PHONESET, pronounce)
        self.assertEqual(len(metadata), 7)
        self.assertEqual(metadata[0]["time"], [0, 4240])
        self.assertEqual(metadata[-1]["time"][1], 29_740)
        for index, row in enumerate(metadata):
            start, end = row["time"]
            self.assertEqual(start, metadata[index - 1]["time"][1] if index else 0)
            self.assertEqual(sum(map(Decimal, row["duration"].split())) * 1_000, end - start)
            self.assertEqual(row["phoneme"], "zh_wei1 zh_wei1 <SP> zh_guang1")

    def test_bad_plan_rejected_before_pronunciation(self):
        for mutate in (
            lambda score: score.pop("phrases"),
            lambda score: score["phrases"].pop(),
            lambda score: score["phrases"][1].update(start=3),
            lambda score: score["phrases"][1].update(startBeats=8.25),
            lambda score: score["phrases"][1].update(endBeats=True),
            lambda score: score["phrases"][1].update(extra=1),
        ):
            score = long_score()
            mutate(score)
            with self.assertRaises(ValueError):
                worker.score_metadata(score, PHONESET, lambda *_args, **_kwargs: self.fail("Premature pronunciation"))

    def test_phrase_cannot_start_inside_melisma(self):
        notes = [{"midi": 60, "beats": 2, "lyric": lyric} for lyric in "微光_微光"]
        score = {
            "bpm": 120, "notes": [dict(note, beats=4) for note in notes],
            "phrases": [
                {"start": 0, "end": 2, "startBeats": 0, "endBeats": 8},
                {"start": 2, "end": 5, "startBeats": 8, "endBeats": 20},
            ],
        }
        with self.assertRaisesRegex(ValueError, "continued syllable"):
            worker.score_metadata(score, PHONESET, pronounce)


class ScoreRenderTests(unittest.TestCase):
    def setUp(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("NumPy is available in the SoulX runtime")
        self.np = np

    def test_batch_loads_model_and_prompt_once_and_places_each_phrase_exactly(self):
        calls = []
        output = {}
        rate = worker.SAMPLE_RATE
        boundary = 4_520
        size = boundary * rate // 1000
        hop = 480

        class Processor:
            def __init__(self, **_kwargs):
                pass

            def process(self, meta, audio):
                calls.append("prompt" if audio else meta["index"])
                return meta

        class Tensor:
            def __init__(self, data):
                self.data = data

            def squeeze(self):
                return self

            def cpu(self):
                return self

            def numpy(self):
                return self.data

        def infer(data, **kwargs):
            self.assertEqual(kwargs, {"n_steps": 32, "cfg": 3, "control": "score"})
            row = data["target"]
            if row["index"] == "first":
                return Tensor(self.np.full(size + hop, 0.25))
            return Tensor(self.np.full(4 * rate - hop, -0.5))

        def model(*_args, **_kwargs):
            calls.append("model")
            return SimpleNamespace(infer=infer)

        config = SimpleNamespace(audio=SimpleNamespace(sample_rate=rate, hop_size=hop),
                                 infer=SimpleNamespace(n_steps=32, cfg=3))
        upstream = {"DataProcessor": Processor, "build_model": model, "load_config": lambda _: config}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prompt = root / "prompt.json"
            prompt.write_text(json.dumps([{"index": "prompt"}]), encoding="utf-8")
            args = SimpleNamespace(prompt_wav=root / "prompt.wav", prompt_metadata=prompt, model=root / "model.pt", device="cpu")
            with patch.object(worker.runpy, "run_path", return_value=upstream), patch.dict(sys.modules, {
                "torch": SimpleNamespace(no_grad=nullcontext),
                "soundfile": SimpleNamespace(write=lambda path, samples, sr, **kwargs:
                                             output.update(path=path, samples=samples, rate=sr, **kwargs)),
            }):
                worker.render_long_score(args, root / "inference.py", root / "config.yaml", root / "phones.json", root, [
                    {"index": "first", "time": [0, boundary]},
                    {"index": "second", "time": [boundary, boundary + 4_000]},
                ])
            self.assertEqual(output["path"], root / "generated.wav")
        self.assertEqual(calls, ["prompt", "model", "first", "second"])
        self.assertEqual(output["rate"], rate)
        self.assertEqual(output["subtype"], "PCM_16")
        samples = output["samples"]
        self.assertEqual(len(samples), size + 4 * rate)
        self.assertTrue(self.np.all(samples[:size] == 0.25))
        self.assertTrue(self.np.all(samples[size:-hop] == -0.5))
        self.assertTrue(self.np.all(samples[-hop:] == 0))

    def test_rejects_bad_engine_output_before_writing_phrase(self):
        size = 4 * worker.SAMPLE_RATE
        output = self.np.zeros(size)
        for audio in (self.np.zeros(size), self.np.full(size, self.np.nan), self.np.ones(size + 4_000),
                      self.np.ones((2, size))):
            with self.assertRaises(ValueError):
                worker.stitch_phrase(output, 0, size, audio)
        self.assertFalse(output.any())


if __name__ == "__main__":
    unittest.main()
