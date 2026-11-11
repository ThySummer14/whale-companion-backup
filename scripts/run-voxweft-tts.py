#!/usr/bin/env python3
"""Run VoxWeft's PCM bridge with a single local voice and no ASR model."""

import argparse
import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
import re
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voxweft-dir", type=Path, help="VoxWeft checkout, if it is not installed")
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--ref-audio", required=True, type=Path)
    parser.add_argument("--voice", default="deepseek-whale-voxcpm2")
    parser.add_argument("--steps", type=int, choices=(4, 6), default=4)
    parser.add_argument("--port", type=int, default=18133)
    args = parser.parse_args()

    if args.voxweft_dir:
        source = args.voxweft_dir.resolve()
        if not (source / "voxweft/runtime/bridge.py").is_file():
            parser.error("--voxweft-dir must contain voxweft/runtime/bridge.py")
        sys.path.insert(0, str(source))

    model_dir = args.model_dir.resolve()
    for filename in ("config.json", "model.safetensors", "tokenizer.json", "vae_mlx.safetensors"):
        if not (model_dir / filename).is_file():
            parser.error(f"Missing model file {filename} in {model_dir}")

    ref_audio = args.ref_audio.resolve()
    if not ref_audio.is_file():
        parser.error("--ref-audio must be a local reference audio file")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", args.voice):
        parser.error("--voice must contain 1 to 80 letters, digits, periods, underscores or hyphens")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    os.environ["VOXCPM2_MODEL"] = str(model_dir)
    os.environ["VOXWEFT_TTS_STEPS"] = str(args.steps)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    try:
        import uvicorn
        from fastapi import FastAPI, HTTPException, Request
        from voxweft.runtime import bridge
    except ModuleNotFoundError as error:
        parser.error(f"Missing {error.name}. Install VoxWeft with its runtime extra in the selected Python environment.")

    def prime():
        model = bridge._ensure_tts_locked()
        bridge._install_voice_prompt_sync(ref_audio.read_bytes(), args.voice)
        for _ in model.generate_streaming(
            "我刚从海边回来，我们要一起去我的世界找一片樱花林。",
            ref_latents=bridge._voices[args.voice],
        ):
            pass

    @asynccontextmanager
    async def lifecycle(_app):
        try:
            await asyncio.get_running_loop().run_in_executor(bridge._tts_executor, prime)
            yield
        finally:
            bridge._shutdown_executors()

    app = FastAPI(title="VoxWeft TTS bridge", lifespan=lifecycle)
    app.add_api_route("/health", bridge.health, methods=["GET"])
    app.add_api_route("/voices", bridge.voices, methods=["GET"])

    @app.get("/ready")
    async def ready():
        return {"status": "ready", "components": {"tts": True, "asr": False, "warmup_done": True}}

    @app.post("/generate")
    async def generate(req: bridge.GenReq, request: Request):
        if not req.target_text.strip() or len(req.target_text) > 240:
            raise HTTPException(status_code=400, detail="Expected 1 to 240 characters")
        if any(requested not in (None, args.voice) for requested in (req.voice, req.external_id)):
            raise HTTPException(status_code=400, detail="Unknown TTS voice")
        return await bridge.generate(req, request)

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
