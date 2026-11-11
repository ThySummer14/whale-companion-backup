#!/usr/bin/env python3
"""Prepare a local MLX IndexTTS 2.0 model and speaker from extracted V4 weights."""

import argparse
import os
from pathlib import Path
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoints", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    source = args.checkpoints.resolve()
    output = args.output_dir.absolute()
    if os.path.lexists(output) or not output.parent.is_dir():
        parser.error("--output-dir must be a new directory under an existing parent")
    if not args.reference.is_file():
        parser.error("--reference must be a local audio file")

    aux = source / "hf_cache"
    w2v = aux / "w2v-bert-2.0"
    offline = {
        ("amphion/MaskGCT", "semantic_codec/model.safetensors"): aux / "semantic_codec_model.safetensors",
        ("funasr/campplus", "campplus_cn_common.bin"): aux / "campplus_cn_common.bin",
        ("nvidia/bigvgan_v2_22khz_80band_256x", "bigvgan_generator.pt"): aux / "bigvgan/bigvgan_generator.pt",
    }
    required = [
        *(source / name for name in ("config.yaml", "bpe.model", "gpt.pth", "s2mel.pth",
                                      "feat1.pt", "feat2.pt", "wav2vec2bert_stats.pt")),
        *offline.values(),
        *(w2v / name for name in ("config.json", "model.safetensors", "preprocessor_config.json")),
    ]
    for path in required:
        if not path.is_file():
            parser.error(f"Missing local checkpoint: {path.relative_to(source)}")

    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", INDEXTTS_W2V_BERT_DIR=str(w2v),
                      TORCH_FORCE_WEIGHTS_ONLY_LOAD="1")
    import huggingface_hub

    def get_local(repo_id, filename, **_):
        path = offline.get((repo_id, filename))
        if path is None:
            raise ValueError("Unexpected remote model dependency")
        return str(path)

    huggingface_hub.hf_hub_download = get_local
    from mlx_indextts import IndexTTSv2
    from mlx_indextts.convert_v2 import convert_model

    with tempfile.TemporaryDirectory(prefix=".indextts2-", dir=output.parent) as staging:
        model_dir = Path(staging) / "model"
        convert_model(source, model_dir, quantize_bits=4)
        engine = IndexTTSv2(str(model_dir), device="mps", quantize_bits=4, memory_limit_gb=8)
        speaker = model_dir / "speaker.npz"
        engine.save_speaker(str(args.reference.resolve()), str(speaker))
        speaker.chmod(0o600)
        model_dir.chmod(0o700)
        if os.path.lexists(output):
            raise FileExistsError("Output directory already exists")
        model_dir.rename(output)


if __name__ == "__main__":
    main()
