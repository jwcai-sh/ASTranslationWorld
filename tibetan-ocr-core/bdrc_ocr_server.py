#!/usr/bin/env python3
"""Small local HTTP wrapper for the BDRC Tibetan OCR pipeline.

This server is intentionally local-only. It exposes:

- GET /health
- POST /ocr with multipart field "file"

It uses the BDRC Tibetan OCR source checkout and the installed Mac app's bundled
OCR models by default.
"""

from __future__ import annotations

import cgi
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import cv2
import numpy as np

try:
    import pytesseract
except Exception:  # pragma: no cover - optional sparse page-number fallback
    pytesseract = None  # type: ignore[assignment]

try:
    from ai_vision_ocr_server import detect_text_line_bboxes, detect_traditional_column_bboxes, detect_physical_text_line_bboxes
except Exception:  # pragma: no cover - layout metadata remains optional
    detect_text_line_bboxes = None  # type: ignore[assignment]
    detect_physical_text_line_bboxes = None
    detect_traditional_column_bboxes = None  # type: ignore[assignment]


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_DIR = PROJECT_ROOT / "tmp" / "tibetan-ocr-app"
DEFAULT_APP_MODELS = Path(
    "/Applications/BDRC Tibetan OCR.app/Contents/MacOS/OCRModels"
)

HOST = os.environ.get("BDRC_OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("BDRC_OCR_PORT", "18090"))
SOURCE_DIR = Path(os.environ.get("BDRC_SOURCE_DIR", str(DEFAULT_SOURCE_DIR))).resolve()
MODELS_DIR = Path(os.environ.get("BDRC_MODELS_DIR", str(DEFAULT_APP_MODELS))).resolve()
MODEL_NAME = os.environ.get("BDRC_MODEL", "Modern")
LINE_MODE = os.environ.get("BDRC_LINE_MODE", "line")
K_FACTOR = float(os.environ.get("BDRC_K_FACTOR", "2.5"))
BBOX_TOLERANCE = float(os.environ.get("BDRC_BBOX_TOLERANCE", "4.0"))
MERGE_LINES = os.environ.get("BDRC_MERGE_LINES", "1") not in {"0", "false", "False"}
USE_TPS = os.environ.get("BDRC_USE_TPS", "0") in {"1", "true", "True"}
MAX_DESKEW_ANGLE = float(os.environ.get("BDRC_MAX_DESKEW_ANGLE", "8.0"))
# Traditional pecha pages can use a modern printed Tibetan face inside their
# classical three-column frame.  The Modern recognizer is materially more
# reliable for the separated horizontal body rows; side columns still use the
# selected traditional profile and their rotation/page-number fallbacks.
TRADITIONAL_CENTER_MODEL = os.environ.get("BDRC_TRADITIONAL_CENTER_MODEL", "Modern")
_pipeline_lock = threading.Lock()
_pipelines: dict[tuple[str, str], Any] = {}
_bdrc_loaded = False

OCR_PROFILES = {
    "handwritten": {"label": "手写体", "model": "Ume_Petsuk", "line_mode": "line"},
    "traditional": {"label": "传统经书印刷版式", "model": "Woodblock-Stacks", "line_mode": "line"},
    "modern": {"label": "现代印刷版式", "model": "Modern", "line_mode": "line"},
}


def is_meaningful_ocr_line(text: str) -> bool:
    """Reject border/punctuation noise while retaining Tibetan text and digits."""
    value = str(text or "").strip()
    return any(
        "\u0f20" <= character <= "\u0f29"
        or "\u0f40" <= character <= "\u0f6c"
        for character in value
    )


def score_ocr_candidate(lines: list[dict[str, Any]]) -> int:
    """Prefer side-column orientations that return more readable Tibetan text."""
    text = "".join(str(line.get("text") or "") for line in lines)
    return sum(
        1 for character in text
        if "\u0f20" <= character <= "\u0f29"
        or "\u0f40" <= character <= "\u0f6c"
    )


def normalize_sparse_page_number(text: str) -> str:
    """Normalize a sparse Western-digit page marker returned by OCR."""
    value = str(text or "")
    matches = re.findall(r"\d+\s*[-–—]\s*\d+", value)
    if matches:
        return re.sub(r"\s+", "", matches[-1]).replace("–", "-").replace("—", "-")
    digits = re.findall(r"\d+", value)
    if len(digits) >= 2:
        return "-".join(digits[-2:])
    return digits[0] if digits else ""


def recognize_sparse_page_number(image: Any, right_aligned: bool = False) -> str:
    if pytesseract is None or image is None:
        return ""
    candidates = [image]
    if right_aligned:
        height, width = image.shape[:2]
        # The page marker is in the narrow far-right compartment; the rest of
        # this region holds red rules and blank paper that confuse Tesseract.
        x0 = max(0, round(width * 0.72))
        x1 = max(x0 + 1, round(width * 0.97))
        y0 = max(0, round(height * 0.06))
        y1 = max(y0 + 1, round(height * 0.92))
        candidates = [image[y0:y1, x0:x1]]

    recognized: list[str] = []
    for candidate in candidates:
        rotations = (candidate, cv2.rotate(candidate, cv2.ROTATE_90_CLOCKWISE), cv2.rotate(candidate, cv2.ROTATE_90_COUNTERCLOCKWISE))
        for rotation in rotations:
            enlarged = cv2.resize(rotation, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
            for page_segmentation_mode in (11, 6):
                try:
                    raw = pytesseract.image_to_string(
                        enlarged,
                        config=f"--psm {page_segmentation_mode} -c tessedit_char_whitelist=0123456789-",
                    )
                except Exception:
                    continue
                normalized = normalize_sparse_page_number(raw)
                if normalized:
                    recognized.append(normalized)
    if not recognized:
        return ""
    return max(recognized, key=lambda value: (len(value.replace("-", "")), len(value)))


def normalized_source_bbox(line: Any, image_shape: tuple[int, ...], angle: float) -> dict[str, float]:
    height, width = image_shape[:2]
    contour = line.contour.astype(np.float32)

    if angle:
        inverse_rotation = cv2.getRotationMatrix2D((width / 2, height / 2), -angle, 1)
        contour = cv2.transform(contour, inverse_rotation)

    x, y, w, h = cv2.boundingRect(contour.astype(np.int32))
    pad_x = max(4, round(w * 0.01))
    pad_y = max(3, round(h * 0.2))
    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_y)
    x1 = min(width, x + w + pad_x)
    y1 = min(height, y + h + pad_y)

    return {
        "x": round(x0 / width, 6),
        "y": round(y0 / height, 6),
        "width": round((x1 - x0) / width, 6),
        "height": round((y1 - y0) / height, 6),
    }


def load_bdrc_modules() -> None:
    global _bdrc_loaded
    if _bdrc_loaded:
        return

    if not SOURCE_DIR.exists():
        raise RuntimeError(
            f"BDRC source directory not found: {SOURCE_DIR}. "
            "Clone it with: git clone https://github.com/buda-base/tibetan-ocr-app.git tmp/tibetan-ocr-app"
        )

    sys.path.insert(0, str(SOURCE_DIR))
    _bdrc_loaded = True


def get_pipeline(model_name: str = MODEL_NAME, line_mode: str = LINE_MODE):
    cache_key = (model_name, line_mode)
    if cache_key in _pipelines:
        return _pipelines[cache_key]

    load_bdrc_modules()

    from BDRC.Data import LayoutDetectionConfig, LineDetectionConfig
    from BDRC.Inference import OCRPipeline
    from BDRC.Utils import get_platform, import_local_model

    model_dir = MODELS_DIR / model_name
    if not model_dir.exists():
        available = ", ".join(sorted(p.name for p in MODELS_DIR.iterdir() if p.is_dir()))
        raise RuntimeError(f"BDRC model not found: {model_dir}. Available models: {available}")

    model = import_local_model(str(model_dir))
    if model is None:
        raise RuntimeError(f"Could not load BDRC model from {model_dir}")

    if line_mode == "layout":
        line_config = LayoutDetectionConfig(
            model_file=str(SOURCE_DIR / "Models" / "Layout" / "photi.onnx"),
            patch_size=512,
            classes=["background", "image", "line", "caption", "margin"],
        )
    else:
        line_config = LineDetectionConfig(
            model_file=str(SOURCE_DIR / "Models" / "Lines" / "PhotiLines.onnx"),
            patch_size=512,
        )

    _pipelines[cache_key] = OCRPipeline(get_platform(), model.config, line_config)
    return _pipelines[cache_key]


def resolve_profile(profile_id: str = "", model_name: str = "", line_mode: str = "") -> tuple[str, str, str]:
    profile = OCR_PROFILES.get(profile_id or "") or {}
    resolved_model = model_name or str(profile.get("model") or MODEL_NAME)
    resolved_line_mode = line_mode or str(profile.get("line_mode") or LINE_MODE)
    resolved_profile = profile_id if profile_id in OCR_PROFILES else "custom"
    return resolved_profile, resolved_model, resolved_line_mode


def run_ocr(
    image_bytes: bytes,
    profile_id: str = "",
    model_name: str = "",
    line_mode: str = "",
) -> dict[str, Any]:
    load_bdrc_modules()

    resolved_profile, resolved_model, resolved_line_mode = resolve_profile(profile_id, model_name, line_mode)

    import pyewts
    from BDRC.Data import CharsetEncoder, Encoding
    from BDRC.line_detection import (
        build_line_data,
        extract_line_images,
        filter_line_contours,
        get_contours,
        get_rotation_angle_from_lines,
        rotate_from_angle,
        sort_lines_by_threshold2,
    )

    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("Uploaded file is not a readable image")

    pipeline = get_pipeline(resolved_model, resolved_line_mode)
    with _pipeline_lock:
        # The upstream pipeline auto-deskews from the line mask. On some clean
        # printed pages it can misread Tibetan line contours as a large rotation
        # (for example -35 or -53 degrees), which ruins line extraction. Guard
        # against that and fall back to no rotation for implausible angles.
        if resolved_line_mode == "layout":
            layout_mask = pipeline.line_inference.predict(image)
            line_mask = layout_mask[:, :, 2]
        else:
            line_mask = pipeline.line_inference.predict(image)

        raw_angle = get_rotation_angle_from_lines(line_mask)
        if abs(raw_angle) <= MAX_DESKEW_ANGLE:
            used_angle = raw_angle
            rot_img = rotate_from_angle(image, raw_angle)
            rot_mask = rotate_from_angle(line_mask, raw_angle)
            angle_guarded = False
        else:
            used_angle = 0.0
            rot_img = image
            rot_mask = line_mask
            angle_guarded = True

        line_contours = get_contours(rot_mask)
        line_contours = [cnt for cnt in line_contours if cv2.contourArea(cnt) > 10]
        if len(rot_mask.shape) == 2:
            rgb_mask = cv2.cvtColor(rot_mask, cv2.COLOR_GRAY2RGB)
        else:
            rgb_mask = rot_mask

        filtered_contours = filter_line_contours(rgb_mask, line_contours)
        if not filtered_contours:
            raise RuntimeError("No valid lines after filtering")

        line_data = [build_line_data(cnt) for cnt in filtered_contours]
        sorted_lines, line_threshold = sort_lines_by_threshold2(
            rgb_mask, line_data, group_lines=MERGE_LINES
        )
        line_images = extract_line_images(
            rot_img,
            sorted_lines,
            default_k=K_FACTOR,
            bbox_tolerance=BBOX_TOLERANCE,
        )

        converter = pyewts.pyewts()
        line_results = []
        for line, line_img in zip(sorted_lines, line_images):
            pred = pipeline.ocr_inference.run(line_img).strip().replace("§", " ")
            if pipeline.encoder == CharsetEncoder.Wylie:
                pred = converter.toUnicode(pred)
            line_results.append({
                "text": pred,
                "bbox": normalized_source_bbox(line, image.shape, used_angle),
            })

    line_texts = [line["text"] for line in line_results]

    return {
        "text": "\n".join(line_texts),
        "lines": line_results,
        "line_count": len(line_texts),
        "detected_line_count": len(sorted_lines),
        "raw_angle": raw_angle,
        "angle": used_angle,
        "angle_guarded": angle_guarded,
        "line_threshold": line_threshold,
        "model": resolved_model,
        "line_mode": resolved_line_mode,
        "profile": resolved_profile,
        "profile_label": OCR_PROFILES.get(resolved_profile, {}).get("label", "自定义"),
    }


def map_local_bbox_to_page(
    local_bbox: dict[str, Any],
    crop_box: tuple[int, int, int, int],
    page_size: tuple[int, int],
    rotation: str = "",
) -> dict[str, float] | None:
    """Map a normalized OCR bbox from a crop back to full-page coordinates.

    ``local_bbox`` is expressed in the image passed to BDRC.  For side
    columns that image may have been rotated before OCR, so map all four
    corners through the inverse rotation rather than assuming the crop axes
    match the page axes.
    """
    if not isinstance(local_bbox, dict):
        return None
    try:
        crop_x, crop_y, crop_width, crop_height = (int(value) for value in crop_box)
        page_width, page_height = (int(value) for value in page_size)
        local_x = float(local_bbox.get("x", 0.0))
        local_y = float(local_bbox.get("y", 0.0))
        local_width = float(local_bbox.get("width", 0.0))
        local_height = float(local_bbox.get("height", 0.0))
    except (TypeError, ValueError):
        return None
    if crop_width <= 0 or crop_height <= 0 or page_width <= 0 or page_height <= 0:
        return None

    oriented_width = crop_height if rotation in {"clockwise", "counterclockwise"} else crop_width
    oriented_height = crop_width if rotation in {"clockwise", "counterclockwise"} else crop_height
    x0 = max(0.0, min(1.0, local_x)) * oriented_width
    y0 = max(0.0, min(1.0, local_y)) * oriented_height
    x1 = max(0.0, min(1.0, local_x + local_width)) * oriented_width
    y1 = max(0.0, min(1.0, local_y + local_height)) * oriented_height

    def inverse(point_x: float, point_y: float) -> tuple[float, float]:
        if rotation == "clockwise":
            # cv2.ROTATE_90_CLOCKWISE: (orig_x, orig_y) ->
            # (crop_height - orig_y, orig_x).
            return point_y, crop_height - point_x
        if rotation == "counterclockwise":
            # cv2.ROTATE_90_COUNTERCLOCKWISE: (orig_x, orig_y) ->
            # (orig_y, crop_width - orig_x).
            return crop_width - point_y, point_x
        return point_x, point_y

    page_points = [
        inverse(x0, y0),
        inverse(x1, y0),
        inverse(x0, y1),
        inverse(x1, y1),
    ]
    absolute_x = [crop_x + point[0] for point in page_points]
    absolute_y = [crop_y + point[1] for point in page_points]
    page_x0 = max(0.0, min(float(page_width), min(absolute_x)))
    page_y0 = max(0.0, min(float(page_height), min(absolute_y)))
    page_x1 = max(0.0, min(float(page_width), max(absolute_x)))
    page_y1 = max(0.0, min(float(page_height), max(absolute_y)))
    return {
        "x": round(page_x0 / page_width, 6),
        "y": round(page_y0 / page_height, 6),
        "width": round(max(0.0, page_x1 - page_x0) / page_width, 6),
        "height": round(max(0.0, page_y1 - page_y0) / page_height, 6),
    }


def merge_nearby_line_bboxes(
    boxes: list[dict[str, float]], max_gap: float = 0.02
) -> list[dict[str, float]]:
    """Merge projection fragments that belong to the same physical text row."""
    merged: list[dict[str, float]] = []
    for raw_box in sorted(boxes, key=lambda item: float(item.get("y", 0.0))):
        try:
            box = {
                "x": float(raw_box["x"]),
                "y": float(raw_box["y"]),
                "width": float(raw_box["width"]),
                "height": float(raw_box["height"]),
            }
        except (KeyError, TypeError, ValueError):
            continue
        if box["width"] <= 0 or box["height"] <= 0:
            continue
        if not merged:
            merged.append(box)
            continue
        previous = merged[-1]
        previous_end = previous["y"] + previous["height"]
        if box["y"] - previous_end > max_gap:
            merged.append(box)
            continue
        x0 = min(previous["x"], box["x"])
        y0 = min(previous["y"], box["y"])
        x1 = max(previous["x"] + previous["width"], box["x"] + box["width"])
        y1 = max(previous_end, box["y"] + box["height"])
        previous.update({
            "x": round(x0, 6),
            "y": round(y0, 6),
            "width": round(x1 - x0, 6),
            "height": round(y1 - y0, 6),
        })
    return merged


def _best_meaningful_ocr_line(result: dict[str, Any]) -> dict[str, Any] | None:
    """Choose the substantive line when BDRC emits rule/punctuation noise."""
    candidates = [
        line for line in result.get("lines", [])
        if is_meaningful_ocr_line(str(line.get("text") or ""))
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda line: len(str(line.get("text") or "").strip()))


def is_red_dominant_ink(image: Any) -> bool:
    """Identify a rubric line that BDRC's black-ink recognizers cannot read."""
    if image is None or image.size == 0:
        return False
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, saturation, _ = cv2.split(hsv)
    red_ink = (saturation >= 120) & ((hue <= 18) | (hue >= 170))
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    black_ink = (gray < 90) & (~red_ink)
    red_count = int(red_ink.sum())
    black_count = int(black_ink.sum())
    return red_count >= 120 and red_count > max(1, black_count) * 3


def run_traditional_center_line_ocr(
    image: Any,
    region: dict[str, Any],
    line_mode: str,
) -> dict[str, Any] | None:
    """Detect and OCR each physical center-row before mapping it to the page."""
    if detect_physical_text_line_bboxes is None:
        return None
    page_height, page_width = image.shape[:2]
    x0 = max(0, round(float(region["x"]) * page_width))
    y0 = max(0, round((float(region["y"]) - float(region["height"]) * .15) * page_height))
    x1 = min(page_width, round((float(region["x"]) + float(region["width"])) * page_width))
    y1 = min(page_height, round((float(region["y"]) + float(region["height"]) * 1.15) * page_height))
    if x1 <= x0 or y1 <= y0:
        return None
    center_crop = image[y0:y1, x0:x1]
    encoded_ok, encoded = cv2.imencode(".png", center_crop)
    if not encoded_ok:
        return None
    line_boxes = detect_physical_text_line_bboxes(encoded.tobytes(), include_masks=True)
    if not 2 <= len(line_boxes) <= 12:
        return None

    line_results: list[dict[str, Any]] = []
    crop_height, crop_width = center_crop.shape[:2]
    horizontal_padding = max(3, round(crop_width * 0.006))
    vertical_padding = max(3, round(crop_height * 0.008))
    for line_box in line_boxes:
        line_y0 = max(0, round(float(line_box["y"]) * crop_height) - vertical_padding)
        line_y1 = min(crop_height, round((float(line_box["y"]) + float(line_box["height"])) * crop_height) + vertical_padding)
        line_x0 = min(max(0, horizontal_padding), max(0, crop_width - 1))
        line_x1 = max(line_x0 + 1, crop_width - horizontal_padding)
        line_crop = center_crop[line_y0:line_y1, line_x0:line_x1].copy()
        exclusion = line_box.get('_exclusion')
        if exclusion is not None:
            paper = np.median(line_crop.reshape(-1, 3), axis=0).astype(np.uint8)
            line_crop[exclusion[line_y0:line_y1, line_x0:line_x1] > 0] = paper
        physical_bbox = {
            "x": round((x0 + float(line_box["x"]) * crop_width) / page_width, 6),
            "y": round((y0 + line_y0) / page_height, 6),
            "width": round(float(line_box["width"]) * crop_width / page_width, 6),
            "height": round((line_y1 - line_y0) / page_height, 6),
        }
        if is_red_dominant_ink(line_crop):
            line_results.append({
                "text": "〔红字待人工转录〕",
                "bbox": physical_bbox,
                "bbox_approximate": False,
                "region_id": region["id"],
                "region_label": region["label"],
                "missing": True,
                "missing_reason": "red-ink",
                "model": "manual-red-ink",
            })
            continue
        encoded_ok, encoded = cv2.imencode(".png", line_crop)
        if not encoded_ok:
            continue
        result = run_ocr(encoded.tobytes(), "custom", TRADITIONAL_CENTER_MODEL, line_mode)
        selected = _best_meaningful_ocr_line(result)
        if selected is None:
            continue
        text = str(selected.get("text") or "").strip()
        mapped = map_local_bbox_to_page(
            selected.get("bbox") or {},
            (x0 + line_x0, y0 + line_y0, line_x1 - line_x0, line_y1 - line_y0),
            (page_width, page_height),
        )
        if mapped is None:
            mapped = dict(region)
        # The recognizer's own contour can be horizontally useful, but its
        # vertical bounds were the original defect.  Anchor Y to the physical
        # projection band from the source page.
        mapped["y"] = round((y0 + line_y0) / page_height, 6)
        mapped["height"] = round((line_y1 - line_y0) / page_height, 6)
        line_results.append({
            "text": text,
            "bbox": mapped,
            "bbox_approximate": False,
            "region_id": region["id"],
            "region_label": region["label"],
            "model": result.get("model", TRADITIONAL_CENTER_MODEL),
        })

    if not line_results:
        return None
    return {
        **region,
        "text": "\n".join(line["text"] for line in line_results),
        "lines": line_results,
        "line_count": len(line_results),
        "empty": False,
        "model": TRADITIONAL_CENTER_MODEL,
        "ocr_rotation": "none",
        "line_segmentation": "source-projection",
    }


def run_traditional_region_ocr(
    image_bytes: bytes,
    profile_id: str,
    model_name: str,
    line_mode: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Return a canonical left/center/right structure for traditional pages."""
    if detect_traditional_column_bboxes is None:
        return payload
    regions = detect_traditional_column_bboxes(image_bytes)
    if len(regions) != 3:
        return payload

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return payload
    height, width = image.shape[:2]
    region_results: list[dict[str, Any]] = []
    for region in regions:
        if region.get("id") == "center":
            try:
                center_result = run_traditional_center_line_ocr(image, region, line_mode)
            except Exception:
                center_result = None
            if center_result is not None:
                region_results.append(center_result)
                continue

        pad_x = max(3, round(width * 0.008))
        best_result: dict[str, Any] | None = None
        best_error = ""
        # A small frame margin keeps sparse title-page rows separate. The full
        # height fallback is retained for pages whose line detector needs the
        # surrounding frame to establish a baseline.
        rotation_names = [""]
        vertical_region = region.get("direction") == "vertical"
        if vertical_region:
            rotation_names.extend(["clockwise", "counterclockwise"])
        best_score = -1
        page_number_found = False
        for rotation_name in rotation_names:
          for pad_y in (max(3, round(height * 0.06)), height):
            x0 = max(0, round(region["x"] * width) - pad_x)
            y0 = max(0, round(region["y"] * height) - pad_y)
            x1 = min(width, round((region["x"] + region["width"]) * width) + pad_x)
            y1 = min(height, round((region["y"] + region["height"]) * height) + pad_y)
            crop_box = (x0, y0, x1 - x0, y1 - y0)
            crop = image[y0:y1, x0:x1]
            if rotation_name == "clockwise":
                crop = cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE)
            elif rotation_name == "counterclockwise":
                crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
            if region.get("id") == "right" and rotation_name:
                # Page numbers sit inside the narrow side strip. Keep the
                # digit pass tight so frame rules do not become false digits.
                dx0 = max(0, round(region["x"] * width))
                dy0 = max(0, round(region["y"] * height))
                dx1 = min(width, round((region["x"] + region["width"]) * width))
                dy1 = min(height, round((region["y"] + region["height"]) * height))
                digit_crop = image[dy0:dy1, dx0:dx1]
                page_number = recognize_sparse_page_number(
                    digit_crop,
                    right_aligned=True,
                )
                if page_number:
                    best_result = {
                        **region,
                        "text": page_number,
                        "lines": [{
                            "text": page_number,
                            "bbox": region,
                            "bbox_approximate": True,
                            "region_id": region["id"],
                            "region_label": region["label"],
                        }],
                        "line_count": 1,
                        "empty": False,
                        "model": "tesseract-page-number",
                        "ocr_rotation": f"tesseract-{rotation_name}",
                    }
                    page_number_found = True
                    break
            ok, encoded = cv2.imencode(".png", crop)
            if not ok:
                continue
            try:
                result = run_ocr(encoded.tobytes(), profile_id, model_name, line_mode)
                source_lines = result.get("lines", [])
                if not source_lines and result.get("text"):
                    source_lines = [{"text": line} for line in str(result["text"]).splitlines()]
                lines = [
                    {
                        "text": str(line.get("text") or "").strip(),
                        "bbox": map_local_bbox_to_page(
                            line.get("bbox") or {},
                            crop_box,
                            (width, height),
                            rotation_name,
                        ) or region,
                        "bbox_approximate": not bool(line.get("bbox")),
                        "region_id": region["id"],
                        "region_label": region["label"],
                    }
                    for line in source_lines
                    if is_meaningful_ocr_line(line.get("text") or "")
                ]
                candidate = {
                    **region,
                    "text": "\n".join(line["text"] for line in lines),
                    "lines": lines,
                    "line_count": len(lines),
                    "empty": not bool(lines),
                    "model": result.get("model", ""),
                    "ocr_rotation": rotation_name or "none",
                }
                candidate_score = score_ocr_candidate(lines)
                if candidate_score > best_score:
                    best_result = candidate
                    best_score = candidate_score
                if lines:
                    break
            except Exception as exc:
                best_error = str(exc)
          if page_number_found:
              break
          if best_result is not None and best_result["lines"] and not vertical_region:
              break

        if best_result is not None:
            if not best_result["lines"] and best_error:
                best_result["error"] = best_error
            region_results.append(best_result)
        else:
            region_results.append({
                **region,
                "text": "",
                "lines": [],
                "line_count": 0,
                "empty": True,
                "error": best_error,
            })

    if len(region_results) != 3:
        return payload
    payload["raw_lines"] = payload.get("lines", [])
    payload["regions"] = region_results
    payload["region_order"] = ["left", "center", "right"]
    payload["lines"] = [
        {
            "text": region["text"],
            "bbox": region,
            "bbox_approximate": False,
            "region_id": region["id"],
            "region_label": region["label"],
            "region_role": region["role"],
            "region_direction": region["direction"],
            "line_count": region.get("line_count", 0),
        }
        for region in region_results
    ]
    payload["text"] = "\n\n".join(region["text"] for region in region_results if region["text"])
    payload["layout_bboxes"] = regions
    payload["layout_bbox_source"] = "traditional-columns"
    payload["region_ocr"] = True
    payload["region_count"] = 3
    return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "BDRCOCRLocal/0.1"

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            try:
                load_bdrc_modules()
                payload = {
                    "ok": True,
                    "model": MODEL_NAME,
                    "line_mode": LINE_MODE,
                    "profiles": OCR_PROFILES,
                    "available_models": sorted(p.name for p in MODELS_DIR.iterdir() if p.is_dir()) if MODELS_DIR.exists() else [],
                    "source_dir": str(SOURCE_DIR),
                    "models_dir": str(MODELS_DIR),
                }
                self.send_json(payload)
            except Exception as exc:
                self.send_json({"ok": False, "error": str(exc)}, status=500)
            return

        self.send_json({"error": "Not found"}, status=404)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/ocr":
            self.send_json({"error": "Not found"}, status=404)
            return

        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                    "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
                },
            )
            if "file" not in form:
                raise RuntimeError('multipart field "file" is required')
            file_item = form["file"]
            image_bytes = file_item.file.read()
            if not image_bytes:
                raise RuntimeError("uploaded file is empty")

            profile_id = str(form.getfirst("ocr_profile", "")).strip()
            model_name = str(form.getfirst("bdrc_model", "")).strip()
            line_mode = str(form.getfirst("bdrc_line_mode", "")).strip()
            payload = run_ocr(image_bytes, profile_id, model_name, line_mode)
            if profile_id == "traditional":
                payload = run_traditional_region_ocr(
                    image_bytes,
                    profile_id,
                    model_name,
                    line_mode,
                    payload,
                )
            self.send_json(payload)
        except Exception as exc:
            self.send_json({"error": str(exc)}, status=500)

    def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))


def main() -> None:
    print(f"BDRC OCR local server: http://{HOST}:{PORT}")
    print(f"source_dir={SOURCE_DIR}")
    print(f"models_dir={MODELS_DIR}")
    print(f"model={MODEL_NAME} line_mode={LINE_MODE}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
