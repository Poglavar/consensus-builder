#!/usr/bin/env python3
"""Build a deterministic, training-only visual audit pack for cadastral labels."""
from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import MultiPolygon, Polygon, shape


SEED = 20261008
HERE = Path(__file__).resolve().parent
DEFAULT_DATASET = HERE / "output/parcel-expanded-check/dataset"
DEFAULT_OUTPUT = HERE / "output/parcel-learning-rate-check/audit"
DENSITY_BINS = ("low", "medium", "high", "dense")
TILE_SIZE_M = 153.6
SOURCE_SIZE = 1024
PANEL_SIZE = 384
MIN_CROP_M = 60.0
TARGET_CROP_CONTEXT_M = 8.0
TILE_EDGE_TOLERANCE_M = 1e-6
MIN_BOUNDARY_SEGMENT_M = 1e-9
THIN_ASPECT_RATIO = 0.12


@dataclass
class Parcel:
    source_id: str
    geometry: Any
    area_m2: float
    bounds: tuple[float, float, float, float]
    clipped_at_tile: bool
    clipped_edge_sides: list[str]
    thin: bool
    area_quintile: int = -1


@dataclass
class Tile:
    tile_id: str
    bbox: tuple[float, float, float, float]
    image_path: Path
    parcels: list[Parcel]
    density_bin: str
    block_index: int


def read_json(path: Path) -> dict:
    with path.open() as stream:
        return json.load(stream)


def _polygon_rings(geometry: Any) -> Iterable[list[tuple[float, float]]]:
    if isinstance(geometry, Polygon):
        yield list(geometry.exterior.coords)
        for ring in geometry.interiors:
            yield list(ring.coords)
    elif isinstance(geometry, MultiPolygon):
        for part in geometry.geoms:
            yield from _polygon_rings(part)


def cadastral_boundary_segments(geometry: Any, tile_bbox: tuple[float, float, float, float],
                                tolerance: float = TILE_EDGE_TOLERANCE_M
                                ) -> tuple[list[tuple[float, float, float, float]], dict[str, float]]:
    """Split polygon rings into real segments and tile-edge clipping segments.

    Segment endpoints within tolerance of the same tile edge make that segment
    an artificial clip boundary. Both label metadata and rendered overlays use
    this classifier so floating-point coordinate noise cannot make them disagree.
    """
    minx, miny, maxx, maxy = tile_bbox
    edge_specs = (("west", 0, minx), ("south", 1, miny), ("east", 0, maxx), ("north", 1, maxy))
    retained: list[tuple[float, float, float, float]] = []
    clipped_lengths = {name: 0.0 for name, _, _ in edge_specs}
    for ring in _polygon_rings(geometry):
        for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
            length = math.hypot(x1 - x0, y1 - y0)
            if length <= MIN_BOUNDARY_SEGMENT_M:
                continue
            side = None
            for name, axis, edge_value in edge_specs:
                first = x0 if axis == 0 else y0
                second = x1 if axis == 0 else y1
                if abs(first - edge_value) <= tolerance and abs(second - edge_value) <= tolerance:
                    side = name
                    break
            if side is None:
                retained.append((x0, y0, x1, y1))
            else:
                clipped_lengths[side] += length
    return retained, {side: length for side, length in clipped_lengths.items()
                      if length > MIN_BOUNDARY_SEGMENT_M}


def _edge_sides(geometry: Any, tile_bbox: tuple[float, float, float, float],
                tolerance: float = TILE_EDGE_TOLERANCE_M) -> list[str]:
    """Return tile edges sharing a positive-length cadastral boundary segment."""
    _, clipped = cadastral_boundary_segments(geometry, tile_bbox, tolerance)
    return list(clipped)


def is_tile_clipped(geometry: Any, tile_bbox: tuple[float, float, float, float],
                    tolerance: float = TILE_EDGE_TOLERANCE_M) -> bool:
    """A parcel is clipped only when its boundary runs along a tile edge."""
    return bool(_edge_sides(geometry, tile_bbox, tolerance))


def world_to_pixel(x: float, y: float, tile_bbox: tuple[float, float, float, float],
                   width: int = SOURCE_SIZE, height: int = SOURCE_SIZE) -> tuple[float, float]:
    """Map EPSG:3765 coordinates into source-image pixel coordinates."""
    minx, miny, maxx, maxy = tile_bbox
    if maxx <= minx or maxy <= miny:
        raise ValueError(f"Invalid tile bounds: {tile_bbox}")
    return ((x - minx) / (maxx - minx) * width,
            (maxy - y) / (maxy - miny) * height)


def _is_thin(geometry: Any) -> bool:
    if geometry.is_empty or geometry.area <= 0:
        return False
    rectangle = geometry.minimum_rotated_rectangle
    if rectangle.is_empty or rectangle.geom_type != "Polygon":
        return False
    coordinates = list(rectangle.exterior.coords)
    sides = [((coordinates[i + 1][0] - coordinates[i][0]) ** 2 +
              (coordinates[i + 1][1] - coordinates[i][1]) ** 2) ** 0.5 for i in range(4)]
    longest = max(sides, default=0.0)
    return longest > 0 and min(sides) / longest <= THIN_ASPECT_RATIO


def load_tile(dataset: Path, tile_id: str, density_bin: str, block_index: int) -> Tile:
    folder = dataset / "train"
    input_data = read_json(folder / f"{tile_id}.input.json")
    truth = read_json(folder / f"{tile_id}.truth.json")
    crs = truth.get("crs", {}).get("properties", {}).get("name")
    if crs != "EPSG:3765":
        raise ValueError(f"{tile_id} truth CRS must be EPSG:3765; got {crs!r}")
    bbox = tuple(float(value) for value in input_data["tile"]["bbox"])
    if len(bbox) != 4:
        raise ValueError(f"{tile_id} has an invalid bbox")
    grouped: dict[str, list[Any]] = {}
    for feature in truth.get("features", []):
        source_id = str(feature.get("properties", {}).get("cestica_id", ""))
        if not source_id:
            continue
        geometry = shape(feature["geometry"])
        if geometry.is_empty or geometry.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        grouped.setdefault(source_id, []).append(geometry)

    parcels = []
    for source_id, geometries in grouped.items():
        # Truth is already tile-clipped. Keep its actual EPSG:3765 polygonal geometry.
        from shapely.ops import unary_union
        geometry = unary_union(geometries)
        if geometry.is_empty or geometry.area <= 0:
            continue
        sides = _edge_sides(geometry, bbox)
        parcels.append(Parcel(source_id, geometry, float(geometry.area), tuple(geometry.bounds),
                             bool(sides), sides, _is_thin(geometry)))
    return Tile(tile_id, bbox, folder / f"{tile_id}.jpg", parcels, density_bin, block_index)


def assign_area_quintiles(parcels: list[Parcel]) -> None:
    """Assign deterministic rank-based area quintiles (one non-empty bucket per quintile)."""
    ordered = sorted(parcels, key=lambda parcel: (parcel.area_m2, parcel.source_id))
    for rank, parcel in enumerate(ordered):
        parcel.area_quintile = min(4, (rank * 5) // len(ordered))


def choose_target_parcels(parcels: list[Parcel], rng: random.Random,
                          excluded_source_ids: set[str] | None = None) -> list[Parcel] | None:
    """Uniformly pick one unique parcel from each area quintile."""
    excluded_source_ids = excluded_source_ids or set()
    available = [parcel for parcel in parcels if parcel.source_id not in excluded_source_ids]
    if len({parcel.source_id for parcel in available}) < 5:
        return None
    assign_area_quintiles(available)
    buckets = [[parcel for parcel in available if parcel.area_quintile == q] for q in range(5)]
    if any(not bucket for bucket in buckets):
        return None
    selected = [rng.choice(bucket) for bucket in buckets]
    if len({parcel.source_id for parcel in selected}) != 5:
        return None
    return selected


def _tile_blocks(manifest: dict) -> list[dict]:
    return [(index, block) for index, block in enumerate(manifest.get("geographic_blocks", []))
            if block.get("split") == "train" and block.get("density_bin") in DENSITY_BINS]


def choose_audit_tiles(dataset: Path, seed: int = SEED) -> tuple[list[tuple[dict, Tile, list[Parcel]]], dict]:
    manifest = read_json(dataset / "manifest.json")
    if manifest.get("crs") != "EPSG:3765":
        raise ValueError("Expanded dataset manifest must use EPSG:3765")
    rng = random.Random(seed)
    block_entries = _tile_blocks(manifest)
    eligible_by_bin: dict[str, list[tuple[int, dict]]] = {name: [] for name in DENSITY_BINS}
    loaded_tiles: dict[str, Tile] = {}
    for block_index, block in block_entries:
        candidates = []
        for tile_id in block.get("tiles", []):
            tile = load_tile(dataset, tile_id, block["density_bin"], block_index)
            loaded_tiles[tile_id] = tile
            if len({parcel.source_id for parcel in tile.parcels}) >= 5:
                candidates.append(tile_id)
        if candidates:
            eligible_by_bin[block["density_bin"]].append((block_index, block, candidates))

    selected: list[tuple[dict, Tile, list[Parcel]]] = []
    used_source_ids: set[str] = set()
    block_selection: dict[str, list[dict]] = {}
    for density_bin in DENSITY_BINS:
        eligible = eligible_by_bin[density_bin]
        if len(eligible) < 3:
            raise ValueError(f"Need 3 eligible training blocks in {density_bin}; found {len(eligible)}")
        rng.shuffle(eligible)
        chosen_blocks = eligible[:3]
        block_selection[density_bin] = []
        for block_index, block, candidate_tiles in chosen_blocks:
            rng.shuffle(candidate_tiles)
            selected_tile = None
            chosen_parcels = None
            for tile_id in candidate_tiles:
                tile = loaded_tiles[tile_id]
                targets = choose_target_parcels(tile.parcels, rng, used_source_ids)
                if targets is not None:
                    selected_tile, chosen_parcels = tile, targets
                    break
            if selected_tile is None or chosen_parcels is None:
                raise ValueError(f"No suitable unique five-parcel tile in selected {density_bin} block {block_index}")
            used_source_ids.update(parcel.source_id for parcel in chosen_parcels)
            block_selection[density_bin].append({
                "manifest_block_index": block_index,
                "bbox": block["bbox"],
                "tile": selected_tile.tile_id,
                "mean_parcel_count": block.get("mean_parcel_count"),
            })
            selected.append((block, selected_tile, chosen_parcels))
    if len(selected) != 12 or len(used_source_ids) != 60:
        raise ValueError(f"Audit selection must contain 12 tiles and 60 unique source IDs; got {len(selected)} / {len(used_source_ids)}")
    return selected, block_selection


def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError:
        return ImageFont.load_default()


def _draw_real_boundary(draw: ImageDraw.ImageDraw, geometry: Any, tile_bbox: tuple[float, float, float, float],
                        transform, color, width: int) -> None:
    segments, _ = cadastral_boundary_segments(geometry, tile_bbox)
    for x0, y0, x1, y1 in segments:
        draw.line([transform(x0, y0), transform(x1, y1)], fill=color, width=width)


def _source_transform(tile_bbox: tuple[float, float, float, float], crop: tuple[int, int, int, int] | None = None,
                      output_size: int = SOURCE_SIZE):
    left, top, right, bottom = crop or (0, 0, SOURCE_SIZE, SOURCE_SIZE)
    crop_w, crop_h = right - left, bottom - top
    return lambda x, y: tuple(int(round(v)) for v in (
        (world_to_pixel(x, y, tile_bbox)[0] - left) * output_size / crop_w,
        (world_to_pixel(x, y, tile_bbox)[1] - top) * output_size / crop_h))


def _crop_box(parcel: Parcel, tile_bbox: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    minx, miny, maxx, maxy = tile_bbox
    min_px = world_to_pixel(parcel.bounds[0], parcel.bounds[3], tile_bbox)[0]
    max_px = world_to_pixel(parcel.bounds[2], parcel.bounds[1], tile_bbox)[0]
    min_py = world_to_pixel(parcel.bounds[2], parcel.bounds[3], tile_bbox)[1]
    max_py = world_to_pixel(parcel.bounds[0], parcel.bounds[1], tile_bbox)[1]
    pixels_per_m_x = SOURCE_SIZE / (maxx - minx)
    pixels_per_m_y = SOURCE_SIZE / (maxy - miny)
    target_width = max_px - min_px + 2 * TARGET_CROP_CONTEXT_M * pixels_per_m_x
    target_height = max_py - min_py + 2 * TARGET_CROP_CONTEXT_M * pixels_per_m_y
    side = min(SOURCE_SIZE, max(int(round(MIN_CROP_M * min(pixels_per_m_x, pixels_per_m_y))),
                                int(round(target_width)), int(round(target_height))))
    cx, cy = (min_px + max_px) / 2, (min_py + max_py) / 2
    left = max(0, min(SOURCE_SIZE - side, int(round(cx - side / 2))))
    top = max(0, min(SOURCE_SIZE - side, int(round(cy - side / 2))))
    return left, top, left + side, top + side


def render_overview(tile: Tile, targets: list[tuple[str, Parcel]], output_path: Path) -> None:
    image = Image.open(tile.image_path).convert("RGB")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    transform = _source_transform(tile.bbox)
    for parcel in tile.parcels:
        _draw_real_boundary(draw, parcel.geometry, tile.bbox, transform, (242, 127, 165, 150), 1)
    image = Image.alpha_composite(image.convert("RGBA"), overlay)
    draw = ImageDraw.Draw(image)
    font = _font(19)
    for audit_id, parcel in targets:
        _draw_real_boundary(draw, parcel.geometry, tile.bbox, transform, (255, 224, 0, 255), 3)
        rp = parcel.geometry.representative_point()
        x, y = transform(rp.x, rp.y)
        label_box = draw.textbbox((x + 4, y - 10), audit_id, font=font, stroke_width=0)
        draw.rounded_rectangle((label_box[0] - 3, label_box[1] - 2, label_box[2] + 3, label_box[3] + 2),
                               radius=3, fill=(16, 16, 16, 230), outline=(255, 224, 0, 255), width=1)
        draw.text((x + 4, y - 10), audit_id, fill=(255, 255, 255, 255), font=font)
    image.convert("RGB").save(output_path, quality=95)


def render_target_panels(tile: Tile, audit_id: str, parcel: Parcel, output_dir: Path) -> tuple[Path, Path]:
    source = Image.open(tile.image_path).convert("RGB")
    crop_box = _crop_box(parcel, tile.bbox)
    rgb = source.crop(crop_box).resize((PANEL_SIZE, PANEL_SIZE), Image.Resampling.LANCZOS)
    overlay = Image.new("RGBA", rgb.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    transform = _source_transform(tile.bbox, crop_box, PANEL_SIZE)
    for other in tile.parcels:
        _draw_real_boundary(draw, other.geometry, tile.bbox, transform, (245, 133, 171, 165), 1)
    # A light wash separates the selected feature from its surroundings while
    # leaving imagery legible for the human reviewer.
    _draw_real_boundary(draw, parcel.geometry, tile.bbox, transform, (255, 230, 0, 255), 4)
    boundary = Image.alpha_composite(rgb.convert("RGBA"), overlay).convert("RGB")
    rgb_path = output_dir / f"{audit_id}_rgb.png"
    boundary_path = output_dir / f"{audit_id}_boundary.png"
    rgb.save(rgb_path, optimize=True)
    boundary.save(boundary_path, optimize=True)
    return rgb_path, boundary_path


def make_contact_sheet(tile: Tile, tile_targets: list[dict], output_dir: Path) -> Path:
    card_height = 420
    margin = 8
    title_height = 28
    width = margin * 3 + PANEL_SIZE * 2
    height = margin + len(tile_targets) * (card_height + margin)
    sheet = Image.new("RGB", (width, height), (242, 242, 242))
    draw = ImageDraw.Draw(sheet)
    font = _font(13)
    for row, record in enumerate(tile_targets):
        top = margin + row * (card_height + margin)
        clipped_text = ("clipped at tile edge (artificial segment excluded)" if record["clipped_at_tile"]
                        else "no tile-edge clipping")
        thin_text = " · thin" if record["thin"] else ""
        title = (f'{record["audit_id"]} · source {record["source_id"]} · {record["area_m2"]:.1f} m² · '
                 f'{clipped_text}{thin_text}')
        draw.text((margin, top), title, fill=(20, 20, 20), font=font)
        rgb = Image.open(output_dir / Path(record["rgb_png"]).name).convert("RGB")
        boundary = Image.open(output_dir / Path(record["boundary_png"]).name).convert("RGB")
        sheet.paste(rgb, (margin, top + title_height))
        sheet.paste(boundary, (margin * 2 + PANEL_SIZE, top + title_height))
        draw.text((margin + 4, top + title_height + 3), "RGB", fill=(255, 255, 255), font=font,
                  stroke_width=2, stroke_fill=(0, 0, 0))
        draw.text((margin * 2 + PANEL_SIZE + 4, top + title_height + 3), "Boundary", fill=(255, 255, 255),
                  font=font, stroke_width=2, stroke_fill=(0, 0, 0))
    path = output_dir / f"{tile.tile_id}_contact.png"
    sheet.save(path, optimize=True)
    return path


def build_audit(dataset: Path, output: Path, seed: int = SEED) -> dict:
    selected_tiles, selected_blocks = choose_audit_tiles(dataset, seed)
    output.mkdir(parents=True, exist_ok=True)
    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    selection_records = []
    tile_records: dict[str, list[dict]] = {}
    audit_number = 1
    for block, tile, parcels in selected_tiles:
        tile_targets = []
        for parcel in parcels:
            audit_id = f"audit_id{audit_number:02d}"
            audit_number += 1
            rgb_path, boundary_path = render_target_panels(tile, audit_id, parcel, image_dir)
            record = {
                "audit_id": audit_id,
                "source_id": parcel.source_id,
                "tile": tile.tile_id,
                "geometry": parcel.geometry.__geo_interface__,
                "area_m2": round(parcel.area_m2, 4),
                "clipped_at_tile": parcel.clipped_at_tile,
                "clipped_edge_sides": parcel.clipped_edge_sides,
                "thin": parcel.thin,
                "area_quintile": parcel.area_quintile,
                "density_bin": tile.density_bin,
                "manifest_block_index": tile.block_index,
                "tile_bbox_epsg3765": list(tile.bbox),
                "tile_overview_png": f"images/{tile.tile_id}_overview.png",
                "rgb_png": f"images/{rgb_path.name}",
                "boundary_png": f"images/{boundary_path.name}",
                "crop_width_source_px": _crop_box(parcel, tile.bbox)[2] - _crop_box(parcel, tile.bbox)[0],
                "annotation": {"visibility": None, "reason": None},
            }
            selection_records.append(record)
            tile_targets.append(record)
        overview_path = image_dir / f"{tile.tile_id}_overview.png"
        render_overview(tile, [(row["audit_id"], parcel) for row, parcel in zip(tile_targets, parcels)], overview_path)
        for row in tile_targets:
            row["contact_sheet_png"] = f"images/{tile.tile_id}_contact.png"
        make_contact_sheet(tile, tile_targets, image_dir)

    audit = {
        "format_version": 1,
        "seed": seed,
        "dataset": "output/parcel-expanded-check/dataset",
        "dataset_split": "train",
        "holdout_tiles_used": False,
        "source_imagery_date": "2022",
        "cadastre_date": "current at export time",
        "crs": "EPSG:3765",
        "selection_method": "Seeded stratified sample: 3 of 4 training geographic blocks per density bin, one eligible tile per selected block, and one uniform random parcel pick per rank-based area quintile. Clipping and thinness are recorded as review metadata, not used as selection criteria. No visibility or temporal-change judgment is inferred.",
        "density_bin_counts": {name: 3 for name in DENSITY_BINS},
        "selected_blocks": selected_blocks,
        "tile_count": 12,
        "parcel_count": len(selection_records),
        "selection": selection_records,
        "contact_sheets": [f'images/{tile.tile_id}_contact.png' for _, tile, _ in selected_tiles],
    }
    (output / "selection.json").write_text(json.dumps(audit, indent=2) + "\n")
    return audit


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", required=True,
                        help="explicitly build the label audit pack")
    parser.add_argument("--dataset", type=Path, required=True,
                        help="expanded dataset directory (must include manifest.json and train/)")
    parser.add_argument("--output", type=Path, required=True,
                        help="audit-pack output directory")
    parser.add_argument("--seed", type=int, default=SEED,
                        help=f"selection seed (default: {SEED})")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    audit = build_audit(args.dataset, args.output, args.seed)
    print(f"Wrote {audit['parcel_count']} training parcels from {audit['tile_count']} tiles to {args.output}")
    print(f"Selection: {args.output / 'selection.json'}")
    for path in audit["contact_sheets"]:
        print(f"Contact sheet: {args.output / path}")


if __name__ == "__main__":
    main()
