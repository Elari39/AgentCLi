# -*- coding: utf-8 -*-
"""
爬取 https://agent.js-bridge.com/#/intro 全站文章与图片并以 Markdown 保存。

站点为 Vite 构建的 SPA，全部文章内容以预渲染 HTML 字符串内嵌在主 bundle 的 `Tl`
对象中。本脚本：
  1. 下载根 HTML，动态提取主 bundle URL；
  2. 下载并解析 bundle，提取 `Tl` 对象中每篇文章的 (key, title, content_html)；
  3. 并发下载全部图片到 public/images/；
  4. 将每篇 HTML 转为 Markdown，改写图片与站内链接为本地相对路径；
  5. 生成 SUMMARY.md 索引。

输出直写前端目录（作为正式数据源，纳入版本管理）：
  - 章节 md + SUMMARY.md  -> src/docs/
  - 图片                   -> public/images/
  - vibe-coding-prompts.md -> public/docs/   （运行时 fetch，避免膨胀主 bundle）
"""

from __future__ import annotations

import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from markdownify import markdownify as md_convert

BASE = "https://agent.js-bridge.com"
ROOT = Path(__file__).resolve().parent
OUT = ROOT / "src" / "docs"          # 章节 md + SUMMARY.md
IMG_DIR = ROOT / "public" / "images"  # 图片
VIBE_DIR = ROOT / "public" / "docs"   # vibe-coding-prompts.md（运行时 fetch）
VIBE_SLUG = "vibe-coding-prompts"
BUNDLE_CACHE = ROOT / "_bundle_cache.js"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
TIMEOUT = 60
MAX_WORKERS = 12

BS = chr(92)  # backslash


# --------------------------------------------------------------------------- #
# 网络
# --------------------------------------------------------------------------- #
def http_get(url: str) -> bytes:
    resp = requests.get(url, headers={"User-Agent": UA}, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.content


def fetch_bundle_text() -> str:
    """下载根 HTML，动态提取主 bundle URL，下载 bundle 并缓存。"""
    if BUNDLE_CACHE.exists():
        print(f"[bundle] 使用缓存 {BUNDLE_CACHE.name}")
        return BUNDLE_CACHE.read_text(encoding="utf-8", errors="replace")

    html = http_get(f"{BASE}/").decode("utf-8", errors="replace")
    m = re.search(r'<script[^>]+src="(/assets/index-[^"]+\.js)"', html)
    if not m:
        raise RuntimeError("无法在根 HTML 中定位主 bundle script 标签")
    bundle_url = BASE + m.group(1)
    print(f"[bundle] 下载 {bundle_url}")
    data = http_get(bundle_url)
    text = data.decode("utf-8", errors="replace")
    BUNDLE_CACHE.write_text(text, encoding="utf-8")
    return text


# --------------------------------------------------------------------------- #
# 解析 Tl 对象
# --------------------------------------------------------------------------- #
def read_backtick(s: str, i: int) -> tuple[str, int]:
    """读取 JS 模板/单/双引号字符串。

    s[i] 为起始引号（反引号、单引号或双引号），返回 (解码内容, 引号结束后的位置)。
    统一处理 \\n / \\t / \\\\ / \\<quote> / \\$ 等转义。
    """
    quote = s[i]
    assert quote in "`'\""
    i += 1
    out: list[str] = []
    n = len(s)
    while i < n:
        c = s[i]
        if c == BS:
            nx = s[i + 1] if i + 1 < n else ""
            if nx == "n":
                out.append("\n")
            elif nx == "t":
                out.append("\t")
            elif nx == "r":
                out.append("\r")
            elif nx == BS:
                out.append(BS)
            elif nx == quote:
                out.append(quote)
            elif nx == "'":
                out.append("'")
            elif nx == '"':
                out.append('"')
            elif nx == "`":
                out.append("`")
            elif nx == "$":
                out.append("$")
            elif nx == "/":
                out.append("/")
            else:
                # 未知转义，保留原样（如 \uXXXX 由后续 normalize 处理）
                out.append(c + nx)
            i += 2
            continue
        if c == quote:
            return "".join(out), i + 1
        out.append(c)
        i += 1
    raise RuntimeError("字符串未闭合")


def read_quoted_at(s: str, i: int) -> tuple[str, int]:
    """s[i:] 以某引号开头时读取；否则跳过空白后读取。返回 (内容, 结束位置)。"""
    while i < len(s) and s[i] in " \t":
        i += 1
    return read_backtick(s, i)


def parse_entries(bundle: str) -> list[tuple[str, str, str]]:
    """解析 Tl 对象，返回 [(key, title, content_html), ...]，保持原始顺序。"""
    i = bundle.find("var Tl=")
    if i < 0:
        raise RuntimeError("未找到 `var Tl=` 声明")
    entries: list[tuple[str, str, str]] = []
    # 匹配条目起始：KEY:{title:`   或   "key":{title:`
    pat = re.compile(r'(?:([A-Za-z0-9_-]+)|"([a-z0-9-]+)"):\{title:`')
    for m in pat.finditer(bundle, i):
        key = m.group(1) or m.group(2)
        bt = m.end() - 1  # 指向 title 的起始反引号
        try:
            title, bt = read_backtick(bundle, bt)
            cm = bundle.find("content:", bt)
            if cm < 0:
                continue
            bt2 = cm + len("content:")  # 指向 content 值的起始（可能为任意引号）
            content, _ = read_quoted_at(bundle, bt2)
        except RuntimeError:
            continue
        entries.append((key, title, content))
    return entries


# --------------------------------------------------------------------------- #
# 图片下载
# --------------------------------------------------------------------------- #
def collect_image_paths(entries: list[tuple[str, str, str]]) -> list[str]:
    paths: set[str] = set()
    for _, _, html in entries:
        paths.update(re.findall(r'src="(/images/[^"]+)"', html))
    return sorted(paths)


def download_one(path: str) -> tuple[str, str]:
    """下载单张图片到镜像目录，返回 (path, status)。status 为 'ok'/'skip'/'fail'。"""
    rel = path.lstrip("/")  # images/...
    # 图片统一落到 IMG_DIR（public/images/），保留源站 images/ 下的相对结构
    if rel.startswith("images/"):
        dest = IMG_DIR / rel[len("images/"):]
    else:
        dest = IMG_DIR / Path(rel).name
    if dest.exists() and dest.stat().st_size > 0:
        return (path, "skip")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = http_get(BASE + path)
        dest.write_bytes(data)
        return (path, "ok")
    except Exception as e:  # noqa: BLE001
        print(f"  [img fail] {path}: {e}")
        return (path, "fail")


def download_images(paths: list[str]) -> list[str]:
    print(f"[img] 共 {len(paths)} 张图片，并发下载（{MAX_WORKERS} workers）...")
    ok = skip = fail = 0
    failed: list[str] = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(download_one, p): p for p in paths}
        for idx, fut in enumerate(as_completed(futures), 1):
            _, status = fut.result()
            if status == "ok":
                ok += 1
            elif status == "skip":
                skip += 1
            else:
                fail += 1
                failed.append(futures[fut])
            if idx % 50 == 0 or idx == len(paths):
                print(f"  进度 {idx}/{len(paths)}  ok={ok} skip={skip} fail={fail}")
    print(f"[img] 完成：ok={ok} skip={skip} fail={fail}")
    return failed


# --------------------------------------------------------------------------- #
# HTML → Markdown
# --------------------------------------------------------------------------- #
def to_markdown(html: str) -> str:
    md = md_convert(
        html,
        heading_style="ATX",
        bullets="-",
        code_language_callback=code_language,
    )
    md = md.strip() + "\n"

    # 图片绝对路径 -> 相对路径
    md = re.sub(r"\]\(/images/", "](images/", md)
    md = md.replace("](/images/", "](images/")  # 兜底
    # 站内 hash 链接 -> 本地 md
    md = re.sub(r"\]\(#/([a-z0-9-]+)\)", r"](\1.md)", md)
    return md


def code_language(el) -> str:
    """从 <pre><code class="language-xxx"> 提取语言标记，用于围栏代码块。

    el 通常是 <pre>，语言 class 在其子 <code> 上；同时兼容 class 直接在 el 上的情形。
    """
    candidates = [el]
    code_els = el.find_all("code") if hasattr(el, "find_all") else []
    candidates.extend(code_els)
    for node in candidates:
        cls = node.get("class", []) or []
        if isinstance(cls, str):
            cls = cls.split()
        for token in cls:
            if token.startswith("language-"):
                return token.replace("language-", "")
    return ""


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    VIBE_DIR.mkdir(parents=True, exist_ok=True)

    bundle = fetch_bundle_text()
    entries = parse_entries(bundle)
    print(f"[parse] 解析到 {len(entries)} 篇文章")

    # 1. 下载图片
    img_paths = collect_image_paths(entries)
    print(f"[parse] 引用图片 {len(img_paths)} 个唯一路径")
    t0 = time.time()
    failed_imgs = download_images(img_paths)
    print(f"[img] 耗时 {time.time() - t0:.1f}s")

    # 2. 转换并写出每篇文章
    #    vibe-coding-prompts 单独写入 public/docs/（运行时 fetch，不进 import.meta.glob）
    summary_lines: list[str] = ["# MewCode Agent 课程目录", ""]
    for key, title, html in entries:
        md = to_markdown(html)
        if key == VIBE_SLUG:
            out_file = VIBE_DIR / f"{key}.md"
        else:
            out_file = OUT / f"{key}.md"
        out_file.write_text(md, encoding="utf-8")
        summary_lines.append(f"- [{title}]({key}.md)")
    (OUT / "SUMMARY.md").write_text("\n".join(summary_lines) + "\n", encoding="utf-8")
    print(f"[md] 已写出 {len(entries)} 篇文章 + SUMMARY.md")

    # 3. 失败图片清单
    if failed_imgs:
        (ROOT / "_failed_images.txt").write_text(
            "\n".join(failed_imgs) + "\n", encoding="utf-8"
        )
        print(f"[warn] {len(failed_imgs)} 张图片下载失败，详见 _failed_images.txt")
    else:
        print("[ok] 全部图片下载成功")

    return 0


if __name__ == "__main__":
    sys.exit(main())
