#!/usr/bin/env python3
"""Serve one prewarmed local Qwen3-ASR model on loopback."""

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from io import BytesIO
from math import gcd
import os
from pathlib import Path
import wave


RATE = 16000
MAX_SECONDS = 15
MAX_BYTES = 48000 * MAX_SECONDS * 2 + 4096


def read_samples(audio):
    import numpy as np
    from scipy.signal import resample_poly

    with wave.open(BytesIO(audio), 'rb') as reader:
        rate = reader.getframerate()
        frames = reader.getnframes()
        if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or rate not in (RATE, 44100, 48000):
            raise ValueError('Expected mono PCM16 WAV')
        if frames > MAX_SECONDS * rate:
            raise ValueError('Recording exceeds 15 seconds')
        data = reader.readframes(frames)
        if len(data) != frames * 2:
            raise ValueError('Truncated PCM frames')
    samples = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768
    if rate != RATE:
        factor = gcd(rate, RATE)
        samples = resample_poly(samples, RATE // factor, rate // factor).astype(np.float32)
    return samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--language', default='Chinese')
    parser.add_argument('--port', type=int, default=18135)
    args = parser.parse_args()
    model_dir = args.model_dir.resolve()
    if not (model_dir / 'config.json').is_file():
        parser.error('--model-dir must point to a local Qwen3-ASR snapshot')
    if not 1 <= args.port <= 65535:
        parser.error('--port must be between 1 and 65535')

    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'

    try:
        import mlx.core as mx
        import numpy as np
        import uvicorn
        from fastapi import FastAPI, HTTPException, Request
        from mlx_audio.stt.utils import load_model
    except ImportError as error:
        parser.error(f'Missing ASR runtime dependency: {error.name}')
    if not hasattr(mx, 'new_thread_local_stream'):
        parser.error('The tested MLX Audio runtime requires MLX 0.32 or later')

    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='companion-asr')
    model = None
    busy = False

    def infer(samples, max_tokens=256):
        return model.generate(samples, language=args.language, max_tokens=max_tokens, verbose=False).text.strip()

    def warmup():
        nonlocal model
        model = load_model(str(model_dir))
        infer(np.zeros(RATE, dtype=np.float32), max_tokens=16)

    def release(_future=None):
        nonlocal busy
        busy = False

    @asynccontextmanager
    async def lifecycle(_app):
        try:
            await asyncio.get_running_loop().run_in_executor(executor, warmup)
            yield
        finally:
            executor.shutdown(cancel_futures=True)

    app = FastAPI(title='Companion local ASR', lifespan=lifecycle, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get('/ready')
    async def ready():
        return {'ready': True}

    @app.post('/transcribe')
    async def transcribe(request: Request):
        nonlocal busy
        if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'audio/wav':
            raise HTTPException(status_code=415, detail='Expected audio/wav')
        if busy:
            raise HTTPException(status_code=409, detail='ASR busy')
        busy = True
        future = None
        try:
            audio = bytearray()
            async for chunk in request.stream():
                if len(audio) + len(chunk) > MAX_BYTES:
                    raise HTTPException(status_code=413, detail='Recording too large')
                audio.extend(chunk)
            try:
                samples = read_samples(audio)
            except (EOFError, ValueError, wave.Error):
                raise HTTPException(status_code=422, detail='Invalid recording') from None
            # A few isolated clicks or digital silence should never enter the speech model.
            width = RATE // 50
            windows = samples[:len(samples) // width * width].reshape(-1, width)
            active = np.flatnonzero(np.mean(windows * windows, axis=1) >= 0.003 ** 2)
            if len(windows) < 10 or active.size < 4:
                return {'text': ''}
            # Keep 200 ms around the recording edges so quiet syllables are retained.
            begin = max(0, int(active[0]) - 10) * width
            end = (int(active[-1]) + 11) * width
            samples = samples[begin:end]
            future = asyncio.get_running_loop().run_in_executor(executor, infer, samples)
            future.add_done_callback(release)
            return {'text': await asyncio.shield(future)}
        finally:
            # If the client disconnects during inference, do not queue more work behind it.
            if future is None:
                release()

    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)


if __name__ == '__main__':
    main()
