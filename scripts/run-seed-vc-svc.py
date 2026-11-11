#!/usr/bin/env python3
"""Run the supported Seed-VC v1 CLI without changing the upstream checkout."""

import os
import sys
from pathlib import Path


def main():
    repo = Path(sys.argv[1]).resolve()
    script = repo / "inference.py"
    source = script.read_text(encoding="utf-8")
    replacements = (
        (
            "torch.from_numpy(F0_ori).to(device)[None]",
            "torch.from_numpy(F0_ori).to(device=device, dtype=torch.float32)[None]",
        ),
        (
            "torch.from_numpy(F0_alt).to(device)[None]",
            "torch.from_numpy(F0_alt).to(device=device, dtype=torch.float32)[None]",
        ),
        (
            "vc_wave.cpu(), sr)",
            'vc_wave.cpu(), sr, encoding="PCM_S", bits_per_sample=16)',
        ),
    )
    for old, new in replacements:
        if source.count(old) != 1:
            raise RuntimeError("Unsupported Seed-VC inference.py revision")
        source = source.replace(old, new, 1)

    os.chdir(repo)
    sys.path.insert(0, str(repo))
    sys.argv = [str(script), *sys.argv[2:]]
    namespace = {"__name__": "__main__", "__file__": str(script)}
    exec(compile(source, str(script), "exec"), namespace)


if __name__ == "__main__":
    main()
