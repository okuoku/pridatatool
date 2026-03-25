#!/usr/bin/env python3
import sys
import csv
import json
import xml.etree.ElementTree as ET
from pathlib import Path

GPX_NS = {"gpx": "http://www.topografix.com/GPX/1/0"}


def parse_gpx(filepath):
    tree = ET.parse(filepath)
    root = tree.getroot()

    results = []
    for trkpt in root.findall(".//gpx:trkpt", GPX_NS):
        time_elem = trkpt.find("gpx:time", GPX_NS)
        ele_elem = trkpt.find("gpx:ele", GPX_NS)
        speed_elem = trkpt.find("gpx:speed", GPX_NS)
        sat_elem = trkpt.find("gpx:sat", GPX_NS)

        entry = [
            time_elem.text if time_elem is not None else None,
            trkpt.get("lon"),
            trkpt.get("lat"),
        ]

        if speed_elem is not None:
            entry.append(speed_elem.text)
        if ele_elem is not None:
            entry.append(ele_elem.text)
        if sat_elem is not None:
            entry.append(int(sat_elem.text))

        results.append(entry)

    return results


def parse_txt(filepath):
    results = []
    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            entry = [
                row["date time"],
                row["longitude"],
                row["latitude"],
            ]

            if row.get("speed(m/s)"):
                entry.append(row["speed(m/s)"])
            if row.get("altitude(m)"):
                entry.append(row["altitude(m)"])
            if row.get("sat_used"):
                entry.append(int(row["sat_used"]))
            if row.get("sat_inview"):
                entry.append(int(row["sat_inview"]))
            if row.get("accuracy(m)"):
                entry.append(row["accuracy(m)"])
            if row.get("bearing(deg)"):
                entry.append(row["bearing(deg)"])

            results.append(entry)

    return results


def main():
    if len(sys.argv) < 2:
        print("Usage: track2json.py <file.gpx|file.txt->", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]

    if input_path == "-":
        content = sys.stdin.read()
        if not content.strip():
            print("[]")
            return
        if content.lstrip().startswith("<?xml") or content.lstrip().startswith("<gpx"):
            import tempfile
            import os

            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".gpx", delete=False
            ) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                results = parse_gpx(tmp_path)
            finally:
                os.unlink(tmp_path)
        else:
            import tempfile
            import os

            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False
            ) as tmp:
                tmp.write(content)
                tmp_path = tmp.name
            try:
                results = parse_txt(tmp_path)
            finally:
                os.unlink(tmp_path)
    else:
        path = Path(input_path)
        suffix = path.suffix.lower()

        if suffix == ".gpx":
            results = parse_gpx(path)
        elif suffix == ".txt" or suffix == ".csv":
            results = parse_txt(path)
        else:
            print(f"Unsupported file format: {suffix}", file=sys.stderr)
            sys.exit(1)

    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
