#!/usr/bin/env python3

import sqlite3
import json
import os
import glob
import sys
from pathlib import Path

DB_PATH = "db.sqlite"
SAVE_DIR = "save"


def init_db(conn):
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS photos (
            oid TEXT PRIMARY KEY,
            latitude REAL,
            longitude REAL,
            latitude_ref TEXT,
            longitude_ref TEXT,
            gps_timestamp TEXT,
            file_path TEXT,
            ref_t TEXT,
            dateaken TEXT,
            camera_make TEXT,
            camera_model TEXT,
            json_file TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_coords ON photos(latitude, longitude)"
    )
    conn.commit()


def get_existing_oids(conn):
    cursor = conn.cursor()
    cursor.execute("SELECT oid FROM photos")
    return set(row[0] for row in cursor.fetchall())


def dms_to_decimal(dms, ref):
    if not dms or len(dms) < 3:
        return None

    try:
        degrees = float(dms[0])
        minutes = float(dms[1])
        seconds = float(dms[2])

        decimal = degrees + (minutes / 60) + (seconds / 3600)

        if ref in ("S", "W"):
            decimal = -decimal

        return decimal
    except (TypeError, ValueError, IndexError):
        return None


def process_json_file(filepath):
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading {filepath}: {e}", file=sys.stderr)
        return None

    oid = Path(filepath).stem

    latitude = None
    longitude = None
    latitude_ref = data.get("GPSLatitudeRef")
    longitude_ref = data.get("GPSLongitudeRef")

    gps_lat = data.get("GPSLatitude")
    gps_lon = data.get("GPSLongitude")

    if gps_lat is not None:
        if isinstance(gps_lat, list):
            latitude = dms_to_decimal(gps_lat, latitude_ref)
        else:
            latitude = float(gps_lat)

    if gps_lon is not None:
        if isinstance(gps_lon, list):
            longitude = dms_to_decimal(gps_lon, longitude_ref)
        else:
            longitude = float(gps_lon)

    if latitude_ref == "S" and latitude is not None and latitude > 0:
        latitude = -latitude
    if longitude_ref == "W" and longitude is not None and longitude > 0:
        longitude = -longitude

    gps_timestamp = data.get("GPSDateStamp", "") + " " + data.get("GPSTimeStamp", "")
    gps_timestamp = gps_timestamp.strip() or None

    file_path = data.get("SourceFile")

    dateaken = data.get("DateTimeOriginal")
    camera_make = data.get("Make")
    camera_model = data.get("Model")

    return {
        "oid": oid,
        "latitude": latitude,
        "longitude": longitude,
        "latitude_ref": latitude_ref,
        "longitude_ref": longitude_ref,
        "gps_timestamp": gps_timestamp,
        "file_path": file_path,
        "ref_t": None,
        "dateaken": dateaken,
        "camera_make": camera_make,
        "camera_model": camera_model,
        "json_file": str(filepath),
    }


def main():
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    existing_oids = get_existing_oids(conn)
    print(f"Existing OIDs in DB: {len(existing_oids)}")

    json_files = glob.glob(os.path.join(SAVE_DIR, "**", "*.json"), recursive=True)
    print(f"Total JSON files: {len(json_files)}")

    to_insert = []
    skipped = 0

    for filepath in json_files:
        oid = Path(filepath).stem
        if oid in existing_oids:
            skipped += 1
            continue

        photo_data = process_json_file(filepath)
        if photo_data:
            to_insert.append(photo_data)

    print(f"Skipped (already in DB): {skipped}")
    print(f"To insert: {len(to_insert)}")

    cursor = conn.cursor()

    for photo in to_insert:
        cursor.execute(
            """
            INSERT OR REPLACE INTO photos (
                oid, latitude, longitude, latitude_ref, longitude_ref,
                gps_timestamp, file_path, ref_t, dateaken, camera_make,
                camera_model, json_file
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                photo["oid"],
                photo["latitude"],
                photo["longitude"],
                photo["latitude_ref"],
                photo["longitude_ref"],
                photo["gps_timestamp"],
                photo["file_path"],
                photo["ref_t"],
                photo["dateaken"],
                photo["camera_make"],
                photo["camera_model"],
                photo["json_file"],
            ),
        )

    conn.commit()

    cursor.execute("SELECT COUNT(*) FROM photos")
    total = cursor.fetchone()[0]
    cursor.execute(
        "SELECT COUNT(*) FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL"
    )
    with_coords = cursor.fetchone()[0]

    print(f"Total records in DB: {total}")
    print(f"Records with coordinates: {with_coords}")

    conn.close()
    print("Done!")


if __name__ == "__main__":
    main()
