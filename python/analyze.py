#!/usr/bin/env python3
"""Scene detection and visual subject center detection for Motify Director."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def detect_scenes(video_path: str) -> list[dict]:
    try:
        from scenedetect import SceneManager, open_video
        from scenedetect.detectors import ContentDetector

        video = open_video(video_path)
        manager = SceneManager()
        manager.add_detector(ContentDetector())
        manager.detect_scenes(video, show_progress=False)
        scene_list = manager.get_scene_list(start_in_scene=True)
        return [
            {
                "index": index + 1,
                "start": round(start.get_seconds(), 3),
                "end": round(end.get_seconds(), 3),
            }
            for index, (start, end) in enumerate(scene_list)
        ]
    except Exception as e:
        print(f"Warning: Scene detection failed ({e}); defaulting to single scene.")
        return []


def detect_subject_center(video_path: str) -> float:
    """Analyze motion across frames to detect horizontal position of the main subject (0.0 to 1.0)."""
    try:
        import cv2
        import numpy as np

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return 0.5

        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        if total_frames < 10 or width <= 0:
            cap.release()
            return 0.5

        # Sample up to 25 frames spaced across the video
        start_frame = min(int(fps * 1.5), total_frames // 4)
        end_frame = max(total_frames - int(fps * 1.5), total_frames * 3 // 4)
        if end_frame <= start_frame:
            start_frame, end_frame = 0, total_frames

        sample_indices = np.linspace(start_frame, end_frame - 1, min(25, max(5, total_frames // 10)), dtype=int)
        
        prev_gray = None
        motion_x_accum = np.zeros(width, dtype=np.float32)

        for idx in sample_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
            ret, frame = cap.read()
            if not ret or frame is None:
                continue

            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            # Downscale slightly for speed and noise reduction
            if prev_gray is not None:
                diff = cv2.absdiff(gray, prev_gray)
                diff = cv2.GaussianBlur(diff, (21, 21), 0)
                # Ignore table bottom 25% where cups/hands move occasionally
                motion_region = diff[: int(height * 0.75), :]
                col_motion = np.sum(motion_region, axis=0)
                motion_x_accum += col_motion
            prev_gray = gray

        cap.release()

        total_motion = np.sum(motion_x_accum)
        if total_motion < 1000:
            return 0.5

        # Smooth and find peak
        kernel_size = max(5, int(width * 0.08))
        kernel = np.ones(kernel_size) / kernel_size
        smoothed = np.convolve(motion_x_accum, kernel, mode="same")
        peak_x = int(np.argmax(smoothed))
        center_fraction = round(float(peak_x) / float(width), 3)
        return max(0.15, min(0.85, center_fraction))
    except Exception as e:
        print(f"Warning: Subject center detection failed ({e}); defaulting to 0.5.")
        return 0.5


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    scenes = detect_scenes(args.video)
    subject_center = detect_subject_center(args.video)

    output = {
        "scenes": scenes,
        "subjectCenter": subject_center,
        "transcript": [],
        "language": None,
    }
    Path(args.output).write_text(json.dumps(output, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
