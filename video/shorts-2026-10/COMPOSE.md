# Composing the two shorts

`asset-manifest.json` lists the nine media assets required by each short, their matching timeline duration, crop guidance, and what each shot needs to show. Most shots require real app or public-source captures; the manifest identifies three supplied, clearly labeled concept diagrams for illustrative council, election, and refund scenarios. Put supplied media under `video/shorts-2026-10/assets/`. For each shot, use the preferred `.mp4` filename; `.mov`, `.m4v`, `.webm`, `.png`, `.jpg`, `.jpeg`, or `.webp` with the same short filename also works. Portrait 9:16 captures are preferred. The renderer never invents or substitutes app UI: if any required shot is missing, it stops and lists the exact filenames to provide.

Render either film after all nine shots are present:

```sh
python3 video/shorts-2026-10/compose.py hero1982-market-scout
python3 video/shorts-2026-10/compose.py jane-park-support
```

The output is `video/shorts-2026-10/out/<film>.mp4`, encoded as 1080×1920 H.264, `yuv420p`, 30 fps, with 48 kHz AAC narration. The renderer reads the existing timeline and SRT, holds short clips on their last frame to match the voiced scene lengths, and shows the complete portrait capture in a centered inset below the title banner and above the captions, on a dark navy canvas. Non-portrait sources are fitted inside the frame with padding; the compositor does not crop or pan app footage. Scene labels and the small “Illustrative devnet scenario” marker use the installed Avenir Next system font. A small `urbangametheory.xyz` footer sits below captions. FFmpeg does the video and audio composition; Pillow creates the transparent typography overlays because this local FFmpeg build has no `drawtext` or `subtitles` filters.

Requirements: Python 3 with Pillow, `fc-match`, `ffmpeg`, and `ffprobe`. No browser launch or app capture is performed by the compositor.
