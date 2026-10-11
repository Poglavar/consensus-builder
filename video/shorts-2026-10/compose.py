#!/usr/bin/env python3
"""Compose one UGT short from its final timeline, narration, subtitles, and supplied real captures.

No app UI is generated here. Every scene requires an input capture or still named in
asset-manifest.json; absent assets are a hard error. Requires ffmpeg/ffprobe, Pillow, and fc-match.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "asset-manifest.json"
OUT = HERE / "out"
WIDTH, HEIGHT, FPS = 1080, 1920, 30
PANEL_WIDTH, PANEL_HEIGHT = 684, 1216
PANEL_X, PANEL_Y = (WIDTH - PANEL_WIDTH) // 2, 240
BACKGROUND = (5, 14, 25, 225)
CYAN = (49, 220, 225, 255)
WHITE = (243, 248, 251, 255)
MUTED = (166, 190, 204, 255)


def run(args: list[str], *, cwd: Path | None = None, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=cwd, check=False, text=True,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        if capture:
            detail = (result.stderr or "").strip().splitlines()[-8:]
            raise RuntimeError("Command failed: " + "\n".join(detail))
        raise RuntimeError(f"Command failed with exit code {result.returncode}: {args[0]}")
    return result.stdout if capture else ""


def probe(path: Path) -> dict:
    raw = run(["ffprobe", "-v", "error", "-show_entries",
               "format=duration:stream=codec_type,width,height,codec_name,sample_rate",
               "-of", "json", str(path)], capture=True)
    data = json.loads(raw)
    video = next((row for row in data.get("streams", []) if row.get("codec_type") == "video"), None)
    audio = next((row for row in data.get("streams", []) if row.get("codec_type") == "audio"), None)
    return {"duration": float(data.get("format", {}).get("duration", 0) or 0),
            "video": video, "audio": audio}


def srt_time(value: str) -> float:
    match = re.fullmatch(r"(\d+):(\d{2}):(\d{2}),(\d{3})", value.strip())
    if not match:
        raise ValueError(f"Invalid SRT timecode: {value}")
    hours, minutes, seconds, millis = map(int, match.groups())
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def parse_srt(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8-sig").strip()
    cues = []
    for block in re.split(r"\n\s*\n", text):
        lines = block.splitlines()
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        left, right = lines[1].split("-->", 1)
        cues.append({"start": srt_time(left), "end": srt_time(right),
                     "text": " ".join(line.strip() for line in lines[2:] if line.strip())})
    if not cues:
        raise ValueError(f"No subtitle cues found in {path}")
    return cues


def candidates_for(scene: dict, extensions: list[str]) -> list[Path]:
    paths = []
    for relative in scene["files"]:
        base = Path(relative)
        for extension in extensions:
            candidate = base.with_suffix(extension)
            if candidate not in paths:
                paths.append(candidate)
    return paths


def resolve_assets(manifest: dict, film: dict, assets_root: Path) -> list[Path]:
    found = []
    missing = []
    root = assets_root.resolve()
    for scene in film["scenes"]:
        selected = None
        for relative in candidates_for(scene, manifest["acceptedExtensions"]):
            path = (root / relative).resolve()
            if not path.is_relative_to(root):
                raise ValueError(f"Manifest asset path escapes assets/: {relative}")
            if path.is_file():
                selected = path
                break
        if selected is None:
            options = ", ".join(str(Path("assets") / p) for p in candidates_for(scene, manifest["acceptedExtensions"]))
            missing.append(f"  {scene['id']}: supply one of {options}\n    shot: {scene['capture']}")
        else:
            found.append(selected)
    if missing:
        raise FileNotFoundError("Missing required real app footage/stills; no fallback UI is used:\n" + "\n".join(missing))
    return found


def font(match: str, size: int) -> ImageFont.FreeTypeFont:
    result = run(["fc-match", "-f", "%{file}|%{index}", match], capture=True).strip()
    path, index = result.rsplit("|", 1)
    return ImageFont.truetype(path, size, index=int(index))


def wrap_text(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if line and draw.textbbox((0, 0), candidate, font=face)[2] > max_width:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def overlay_png(path: Path, film_label: str, scene_number: int, scene_count: int,
                scene_label: str, caption: str | None, regular: ImageFont.FreeTypeFont,
                semibold: ImageFont.FreeTypeFont,
                caption_faces: tuple[ImageFont.FreeTypeFont, ImageFont.FreeTypeFont,
                                     ImageFont.FreeTypeFont]) -> None:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")
    # Small, persistent scenario marker; the narration supplies the full caveat.
    draw.rounded_rectangle((64, 66, 1016, 207), radius=20,
                           fill=(5, 14, 25, 208), outline=(49, 220, 225, 88), width=2)
    draw.rounded_rectangle((64, 66, 72, 207), radius=4, fill=CYAN)
    draw.ellipse((96, 91, 108, 103), fill=CYAN)
    draw.text((122, 84), "URBAN GAME THEORY", font=semibold, fill=WHITE)
    scenario = "ILLUSTRATIVE DEVNET SCENARIO"
    scenario_width = draw.textbbox((0, 0), scenario, font=regular)[2]
    draw.text((984 - scenario_width, 87), scenario, font=regular, fill=MUTED)
    draw.line((96, 127, 984, 127), fill=(49, 220, 225, 68), width=1)
    draw.text((96, 145), f"{scene_number:02d} / {scene_count:02d}", font=regular, fill=CYAN)
    draw.text((197, 140), f"{film_label}  /  {scene_label}", font=semibold, fill=WHITE)
    # Keep the portrait capture below the persistent title and above captions.
    draw.rounded_rectangle((PANEL_X - 2, PANEL_Y - 2,
                            PANEL_X + PANEL_WIDTH + 2, PANEL_Y + PANEL_HEIGHT + 2),
                           radius=8, outline=(49, 220, 225, 150), width=2)

    footer = "urbangametheory.xyz"
    footer_width = draw.textbbox((0, 0), footer, font=semibold)[2]
    draw.text(((WIDTH - footer_width) / 2, 1774), footer, font=semibold, fill=MUTED)

    if caption:
        cap_font = caption_faces[0]
        lines = wrap_text(draw, caption, cap_font, 870)
        if len(lines) > 3:
            cap_font = caption_faces[1]
            lines = wrap_text(draw, caption, cap_font, 870)
        if len(lines) > 3:
            cap_font = caption_faces[2]
            lines = wrap_text(draw, caption, cap_font, 870)
        line_height = 58 if cap_font.size >= 43 else 52 if cap_font.size >= 38 else 47
        text_height = line_height * len(lines)
        box_height = text_height + 42
        box_left, box_right = 64, 1016
        box_bottom = 1692
        box_top = box_bottom - box_height
        draw.rounded_rectangle((box_left, box_top, box_right, box_bottom), radius=20,
                               fill=BACKGROUND, outline=(49, 220, 225, 105), width=2)
        draw.rounded_rectangle((box_left, box_top + 18, box_left + 7, box_bottom - 18), radius=3, fill=CYAN)
        y = box_top + 21
        for line in lines:
            draw.text((box_left + 30, y), line, font=cap_font, fill=WHITE)
            y += line_height
    image.save(path)


def make_overlay_video(timeline: dict, cues: list[dict], film: dict, work: Path) -> Path:
    regular = font("Avenir Next:style=Regular", 23)
    semibold = font("Avenir Next:style=Demi Bold", 25)
    caption_faces = (font("Avenir Next:style=Demi Bold", 43),
                     font("Avenir Next:style=Demi Bold", 38),
                     font("Avenir Next:style=Demi Bold", 34))
    total = float(timeline["durationSeconds"])
    scenes = timeline["scenes"]
    bounds = {0.0, total}
    for scene in scenes:
        bounds.add(max(0, float(scene["startSeconds"])))
        bounds.add(min(total, float(scene["startSeconds"]) + float(scene["durationSeconds"])))
    for cue in cues:
        bounds.add(max(0, min(total, cue["start"])))
        bounds.add(max(0, min(total, cue["end"])))
    # Snap every overlay transition to the 30 fps output clock.
    ticks = sorted({round(value * FPS) for value in bounds})
    times = [tick / FPS for tick in ticks]
    pngs = work / "overlay-frames"
    pngs.mkdir()
    list_lines = ["ffconcat version 1.0"]
    intervals = 0
    for index, (start, end) in enumerate(zip(times, times[1:])):
        if end - start < 1 / FPS - 1e-6:
            continue
        middle = (start + end) / 2
        scene_index = next((i for i, row in enumerate(scenes)
                            if float(row["startSeconds"]) <= middle < float(row["startSeconds"]) + float(row["durationSeconds"])),
                           len(scenes) - 1)
        scene_manifest = film["scenes"][scene_index]
        active = next((cue for cue in cues if cue["start"] <= middle < cue["end"]), None)
        image_path = pngs / f"{intervals:05d}.png"
        overlay_png(image_path, film["label"], scene_index + 1, len(scenes),
                    scene_manifest["shortLabel"], active["text"] if active else None,
                    regular, semibold, caption_faces)
        list_lines.append(f"file '{image_path.relative_to(work).as_posix()}'")
        list_lines.append(f"duration {end - start:.6f}")
        intervals += 1
    if intervals == 0:
        raise ValueError("No overlay frames were generated")
    list_lines.append(f"file 'overlay-frames/{intervals - 1:05d}.png'")
    (work / "overlays.ffconcat").write_text("\n".join(list_lines) + "\n", encoding="utf-8")
    output = work / "overlays.mov"
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", "overlays.ffconcat", "-vf", "fps=30,format=argb", "-frames:v", str(math.ceil(total * FPS)),
         "-c:v", "qtrle", "-pix_fmt", "argb", str(output)], cwd=work)
    return output


def compose(film_id: str, assets_root: Path, output_path: Path) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    film = manifest["films"].get(film_id)
    if film is None:
        raise ValueError(f"Film not found in asset manifest: {film_id}")
    timeline_path = OUT / f"{film_id}-timeline.json"
    srt_path = OUT / f"{film_id}.srt"
    if not timeline_path.is_file() or not srt_path.is_file():
        raise FileNotFoundError(f"Missing final timeline or SRT under {OUT}; generate narration assets first.")
    timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
    if [row["id"] for row in timeline["scenes"]] != [row["id"] for row in film["scenes"]]:
        raise ValueError(f"Timeline scene order does not match {MANIFEST.name} for {film_id}")
    for scene, planned in zip(timeline["scenes"], film["scenes"]):
        if abs(float(scene["durationSeconds"]) - float(planned["requiredTimelineSeconds"])) > 0.1:
            raise ValueError(f"Timeline changed for {scene['id']}; refresh its requiredTimelineSeconds in {MANIFEST.name}")
    audio_value = Path(timeline["audioFile"])
    audio_path = audio_value if audio_value.is_absolute() else HERE / audio_value
    if not audio_path.is_file():
        raise FileNotFoundError(f"Missing narration track: {audio_path}")
    cues = parse_srt(srt_path)
    assets = resolve_assets(manifest, film, assets_root)
    probes = [probe(path) for path in assets]
    for path, info in zip(assets, probes):
        if not info["video"] or not info["video"].get("width") or not info["video"].get("height"):
            raise ValueError(f"Capture is not a readable video or still image: {path}")
    total = float(timeline["durationSeconds"])
    voice_duration = probe(audio_path)["duration"]
    if abs(voice_duration - total) > 0.35:
        raise ValueError(f"Narration duration ({voice_duration:.3f}s) and timeline ({total:.3f}s) differ by more than 0.35s")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"compose-{film_id}-", dir=output_path.parent) as temp_name:
        work = Path(temp_name)
        overlay = make_overlay_video(timeline, cues, film, work)
        graph: list[str] = []
        input_args: list[str] = []
        for index, (asset, info, scene) in enumerate(zip(assets, probes, timeline["scenes"])):
            duration = float(scene["durationSeconds"])
            if asset.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
                input_args += ["-loop", "1", "-framerate", str(FPS), "-t", f"{duration:.6f}", "-i", str(asset)]
            else:
                input_args += ["-i", str(asset)]
            graph.append(
                f"[{index}:v]fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=0x050e19,"
                f"setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={duration:.6f},"
                f"trim=duration={duration:.6f},setpts=PTS-STARTPTS[v{index}]"
            )
        concat_inputs = "".join(f"[v{i}]" for i in range(len(assets)))
        graph.append(f"{concat_inputs}concat=n={len(assets)}:v=1:a=0[vraw]")
        graph.append(f"color=c=0x050e19:s={WIDTH}x{HEIGHT}:r={FPS}:d={total:.6f},format=rgba[vbg]")
        graph.append(f"[vraw]scale={PANEL_WIDTH}:{PANEL_HEIGHT},setsar=1[vpanel]")
        graph.append(f"[vbg][vpanel]overlay={PANEL_X}:{PANEL_Y}:shortest=1[vbase]")
        overlay_index = len(assets)
        audio_index = overlay_index + 1
        input_args += ["-i", str(overlay), "-i", str(audio_path)]
        graph.append(f"[vbase][{overlay_index}:v]overlay=0:0:eof_action=repeat:format=auto,format=yuv420p[outv]")
        if output_path.exists():
            output_path.unlink()
        try:
            run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "warning", *input_args,
                 "-filter_complex", ";".join(graph), "-map", "[outv]", "-map", f"{audio_index}:a:0",
                 "-t", f"{total:.6f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "slow", "-crf", "18",
                 "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                 "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-movflags", "+faststart", str(output_path)])
        except Exception:
            output_path.unlink(missing_ok=True)
            raise
    details = probe(output_path)
    stream = details["video"] or {}
    audio = details["audio"] or {}
    if (stream.get("codec_name"), stream.get("width"), stream.get("height")) != ("h264", WIDTH, HEIGHT):
        raise RuntimeError(f"Rendered video failed output checks: {stream}")
    if audio.get("codec_name") != "aac":
        raise RuntimeError(f"Rendered audio failed output checks: {audio}")
    if audio.get("sample_rate") != "48000":
        raise RuntimeError(f"Rendered audio is not 48 kHz: {audio}")
    print(f"Rendered {output_path} · {details['duration']:.1f}s · H.264 1080×1920 · AAC 48 kHz")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("film", choices=["hero1982-market-scout", "jane-park-support"])
    parser.add_argument("--assets", type=Path, default=HERE / "assets", help="Root folder for the supplied real app captures (default: this folder/assets)")
    parser.add_argument("--output", type=Path, help="MP4 path (default: out/<film>.mp4)")
    args = parser.parse_args()
    output_path = (args.output or (OUT / f"{args.film}.mp4")).resolve()
    try:
        compose(args.film, args.assets.resolve(), output_path)
    except (FileNotFoundError, ValueError, RuntimeError, OSError) as error:
        print(f"Cannot render {args.film}: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
