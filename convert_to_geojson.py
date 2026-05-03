#!/usr/bin/env python3

import sqlite3
import json
import argparse
import sys

DB_PATH = "db.sqlite"


def is_valid_coord(lat, lon):
    if lat is None or lon is None:
        return False
    try:
        lat = float(lat)
        lon = float(lon)
        return -90 <= lat <= 90 and -180 <= lon <= 180
    except (TypeError, ValueError):
        return False


def fetch_photos(conn, start_date=None, end_date=None, camera=None):
    cursor = conn.cursor()

    query = """
        SELECT oid, latitude, longitude, dateaken, camera_make, camera_model, file_path, ref_t
        FROM photos
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    """
    params = []

    if start_date:
        query += " AND dateaken >= ?"
        params.append(start_date)
    if end_date:
        query += " AND dateaken <= ?"
        params.append(end_date)
    if camera:
        query += " AND (camera_make LIKE ? OR camera_model LIKE ?)"
        params.extend([f"%{camera}%", f"%{camera}%"])

    cursor.execute(query, params)
    return cursor.fetchall()


def convert_to_geojson(photos):
    features = []
    seen_coords = set()

    for row in photos:
        (
            oid,
            latitude,
            longitude,
            datetaken,
            camera_make,
            camera_model,
            file_path,
            ref_t,
        ) = row

        if not is_valid_coord(latitude, longitude):
            continue

        coords = (float(latitude), float(longitude))
        if coords in seen_coords:
            continue
        seen_coords.add(coords)

        feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
            "properties": {
                "oid": oid,
                "datetime": datetaken or "",
                "camera_make": camera_make or "",
                "camera_model": camera_model or "",
                "file_path": file_path or "",
                "ref": ref_t,
            },
        }
        features.append(feature)

    return {"type": "FeatureCollection", "features": features}


def main():
    parser = argparse.ArgumentParser(
        description="Convert SQLite coordinates to GeoJSON"
    )
    parser.add_argument("--output", help="Output file path (default: stdout)")
    parser.add_argument("--start", help="Start date filter (YYYY:MM:DD HH:MM:SS)")
    parser.add_argument("--end", help="End date filter (YYYY:MM:DD HH:MM:SS)")
    parser.add_argument("--camera", help="Camera filter (make or model)")
    args = parser.parse_args()

    conn = sqlite3.connect(DB_PATH)

    try:
        photos = fetch_photos(conn, args.start, args.end, args.camera)
        geojson = convert_to_geojson(photos)

        json_output = json.dumps(geojson, ensure_ascii=False, indent=2)

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(json_output)
            print(f"Output written to {args.output}")
        else:
            print(json_output)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
