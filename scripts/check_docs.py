from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
files = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]
errors = []
link_pattern = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")

for file in files:
    text = file.read_text(encoding="utf-8")
    if text.count("```") % 2:
        errors.append(f"{file.relative_to(ROOT)}: 代码围栏数量不成对")
    for target in link_pattern.findall(text):
        target = target.strip().split()[0].strip("<>")
        if target.startswith(("https://", "http://", "#")):
            continue
        path_part = target.split("#", 1)[0]
        if path_part and not (file.parent / path_part).resolve().exists():
            errors.append(f"{file.relative_to(ROOT)}: 本地链接不存在 -> {target}")
    print(f"{file.relative_to(ROOT)}: {len(text.splitlines())} 行")

if errors:
    print("\n检查失败：")
    for error in errors:
        print(f"- {error}")
    raise SystemExit(1)

print(f"\n检查通过：{len(files)} 份文档，本地链接与代码围栏正常。")
