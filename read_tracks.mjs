import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import child_process from "child_process";
import { createRequire } from "node:module";
import https from "node:https";
import http from "node:http";

const require = createRequire(import.meta.url);
const OpenLocationCode = require("./openlocationcode.js");

const TRACK_EXTENSIONS = [".txt", ".gpx", ".kml"];
const PRIORITY_EXT = { ".txt": 0, ".gpx": 1, ".kml": 2 };

const CONCURRENCY = 16;
const WORKER_COUNT = 4;
const SEGMENT_SIZE = 1000;

function parseArgs() {
    const args = process.argv.slice(2);
    let gitdir = "photos.git";
    let gitea_host = null;
    let tokenArg = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--gitdir" && i + 1 < args.length) {
            gitdir = args[++i];
        } else if (args[i] === "--gitea-host" && i + 1 < args.length) {
            gitea_host = args[++i];
        } else if (args[i] === "--token" && i + 1 < args.length) {
            tokenArg = args[++i];
        }
    }

    return { gitdir, gitea_host, tokenArg };
}

async function getToken(tokenArg) {
    if (tokenArg) return tokenArg;
    return process.env.GITEA_TOKEN || null;
}

async function rungit(cmd, gitdir) {
    return new Promise((resolve, reject) => {
        child_process.execFile("git", cmd, { cwd: gitdir }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve(stdout.trim());
        });
    });
}

function make_reader(gitdir) {
    const child = child_process.spawn("git", ["cat-file", "--batch"],
        { cwd: gitdir, stdio: ["pipe", "pipe", "inherit"] });

    let in_header = true;
    let headerbuf = [];
    let bodybuf = [];
    let bodysize = 0;
    let queuedsize = 0;
    let recv = null;
    let pendingError = null;
    let locked = false;
    let releaseCallback = null;

    child.stdout.on("data", (dat) => {
        function consumebody(buf) {
            if ((bodysize + 1) === queuedsize + buf.length) {
                if (buf.length !== 1) {
                    bodybuf.push(buf.subarray(0, buf.length - 1));
                }
                const out = Buffer.concat(bodybuf);
                bodybuf = [];
                queuedsize = 0;
                in_header = true;
                if (recv) recv(out);
            } else {
                bodybuf.push(buf);
                queuedsize += buf.length;
                if (queuedsize > bodysize) {
                    pendingError = "size mismatch";
                }
            }
        }
        function parseheader() {
            const re = /([0-9a-f]+) blob ([0-9]+)/;
            const header = Buffer.concat(headerbuf).toString("utf8");
            headerbuf = [];
            const m = header.match(re);
            if (m) {
                bodysize = parseInt(m[2]);
                in_header = false;
            } else {
                bodysize = 0;
            }
        }

        if (in_header) {
            const lfidx = dat.indexOf(0x0a);
            if (lfidx === -1) {
                headerbuf.push(dat);
            } else {
                if (lfidx !== 0) {
                    headerbuf.push(dat.subarray(0, lfidx));
                }
                parseheader();
                if (bodysize !== false) {
                    if (lfidx + 1 !== dat.length) {
                        consumebody(dat.subarray(lfidx + 1, dat.length));
                    }
                } else {
                    if (recv) recv(false);
                }
            }
        } else {
            consumebody(dat);
        }
    });

    child.on("error", (e) => {
        pendingError = e;
    });

    return {
        lock: async function() {
            return new Promise((resolve) => {
                if (!locked) {
                    locked = true;
                    resolve();
                } else {
                    releaseCallback = resolve;
                }
            });
        },
        unlock: function() {
            if (releaseCallback) {
                const cb = releaseCallback;
                releaseCallback = null;
                cb();
            } else {
                locked = false;
            }
        },
        get: async function(refpath) {
            const writedata = refpath + "\n";
            return new Promise((resolve, reject) => {
                if (pendingError) {
                    reject(pendingError);
                    return;
                }
                if (recv) {
                    reject("overlapped");
                    return;
                }
                recv = function(blob) {
                    recv = null;
                    resolve(blob);
                };
                child.stdin.write(writedata, "utf8");
            });
        },
        dispose: async function() {
            return new Promise((resolve) => {
                child.stdin.end(() => resolve());
            });
        }
    };
}

function make_reader_pool(gitdir, size) {
    const readers = [];
    for (let i = 0; i < size; i++) {
        readers.push(make_reader(gitdir));
    }
    let current = 0;

    return {
        acquire: async function() {
            const reader = readers[current];
            current = (current + 1) % readers.length;
            await reader.lock();
            return reader;
        },
        release: function(reader) {
            reader.unlock();
        },
        dispose: async function() {
            for (const reader of readers) {
                await reader.dispose();
            }
        }
    };
}

function isTrackFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return TRACK_EXTENSIONS.includes(ext);
}

function getPriority(filename) {
    const ext = path.extname(filename).toLowerCase();
    return PRIORITY_EXT[ext] ?? 99;
}

async function loadProcessedTrackIds() {
    const processed = new Set();
    const trackDir = "track/tracks";
    try {
        const years = await fs.readdir(trackDir);
        for (const year of years) {
            const yearPath = path.join(trackDir, year);
            const months = await fs.readdir(yearPath);
            for (const month of months) {
                const monthPath = path.join(yearPath, month);
                const days = await fs.readdir(monthPath);
                for (const day of days) {
                    const dayPath = path.join(monthPath, day);
                    const files = await fs.readdir(dayPath);
                    for (const file of files) {
                        if (file.endsWith(".json")) {
                            const id = file.replace(".json", "");
                            processed.add(id);
                        }
                    }
                }
            }
        }
    } catch {}
    return processed;
}

async function getLfsPointerContent(reader, commit, filePath) {
    try {
        const content = await reader.get(commit + ":" + filePath);
        if (!content) return null;

        const text = content.toString("utf8");
        const oidMatch = text.match(/^oid sha256:([a-f0-9]{64})/m);
        const sizeMatch = text.match(/^size (\d+)/m);

        if (oidMatch && sizeMatch) {
            return {
                oid: oidMatch[1],
                size: parseInt(sizeMatch[1])
            };
        }
        return null;
    } catch {
        return null;
    }
}

async function downloadLfsFile(gitea_host, token, oid) {
    const url = `${gitea_host}/info/lfs/objects/${oid}`;

    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === "https:" ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: "GET",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        };

        const req = protocol.request(options, (res) => {
            if (res.statusCode !== 200) {
                console.error(`Failed to download LFS file ${oid}: ${res.statusCode} ${urlObj}`);
                resolve(null);
                return;
            }

            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                resolve(Buffer.concat(chunks));
            });
        });

        req.on("error", (err) => {
            console.error(`Failed to download LFS file ${oid}: ${err.message}`);
            resolve(null);
        });

        req.end();
    });
}

function computeTrackId(basename) {
    return crypto.createHash("sha256").update("pritrack" + basename).digest("hex");
}

function getEarliestDate(points, ext) {
    if (!points || points.length === 0) return null;
    
    for (const point of points) {
        if (!point || !point[0]) continue;
        
        const timeStr = point[0];
        if (ext === ".txt") {
            const match = timeStr.match(/(\d{4}-\d{2}-\d{2})/);
            if (match) return match[1];
        } else if (ext === ".gpx" || ext === ".kml") {
            const match = timeStr.match(/(\d{4}-\d{2}-\d{2})T/);
            if (match) return match[1];
        }
    }
    return null;
}

function parseTxt(content) {
    const lines = content.split("\n").map(l => l.trim()).filter(l => l);
    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
    const points = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(",").map(v => v.trim());
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = values[idx] || "";
        });

        const lat = parseFloat(row["latitude(deg)"]);
        const lon = parseFloat(row["longitude(deg)"]);
        if (isNaN(lat) || isNaN(lon)) continue;

        const point = [
            row["time"],
            lon.toString(),
            lat.toString()
        ];

        const speed = row["speed(m/s)"];
        if (speed) point.push(speed);

        const alt = row["altitude(m)"];
        if (alt) point.push(alt);

        const satUsed = row["sat_used"];
        if (satUsed) point.push(parseInt(satUsed) || null);

        const satInview = row["sat_inview"];
        if (satInview) point.push(parseInt(satInview) || null);

        const acc = row["accuracy(m)"];
        if (acc) point.push(acc);

        const bearing = row["bearing(deg)"];
        if (bearing) point.push(bearing);

        while (point.length > 3 && point[point.length - 1] === null) {
            point.pop();
        }

        points.push(point);
    }

    return points;
}

function parseGpx(content) {
    const points = [];
    const timeMatch = content.match(/<trkpt[^>]*>([\s\S]*?)<\/trkpt>/g) || [];

    for (const trkpt of timeMatch) {
        const latMatch = trkpt.match(/lat="([^"]+)"/);
        const lonMatch = trkpt.match(/lon="([^"]+)"/);
        if (!latMatch || !lonMatch) continue;

        const lat = latMatch[1];
        const lon = lonMatch[1];

        const point = [null, lon, lat];

        const timeMatch2 = trkpt.match(/<time>([^<]+)<\/time>/);
        if (timeMatch2) point[0] = timeMatch2[1];

        const eleMatch = trkpt.match(/<ele>([^<]+)<\/ele>/);
        if (eleMatch) point.push(eleMatch[1]);

        const speedMatch = trkpt.match(/<speed>([^<]+)<\/speed>/);
        if (speedMatch) point.push(speedMatch[1]);

        const satMatch = trkpt.match(/<sat>(\d+)<\/sat>/);
        if (satMatch) point.push(parseInt(satMatch[1]));

        while (point.length > 3 && point[point.length - 1] === null) {
            point.pop();
        }

        points.push(point);
    }

    return points;
}

function parseKml(content) {
    const points = [];
    const whenMatch = content.match(/<when>([^<]+)<\/when>/g) || [];

    for (let i = 0; i < whenMatch.length; i++) {
        const timeStr = whenMatch[i].replace(/<when>|<\/when>/g, "");

        const coordMatch = content.match(/<gx:coord>([^<]+)<\/gx:coord>/);
        if (!coordMatch) continue;

        const coords = coordMatch[1].trim().split(/\s+/);
        if (coords.length < 2) continue;

        const point = [
            timeStr,
            coords[0],
            coords[1]
        ];

        if (coords.length >= 3) point.push(coords[2]);

        while (point.length > 3 && point[point.length - 1] === null) {
            point.pop();
        }

        points.push(point);
    }

    return points;
}

function parseTrack(content, ext) {
    if (ext === ".txt") return parseTxt(content);
    if (ext === ".gpx") return parseGpx(content);
    if (ext === ".kml") return parseKml(content);
    return [];
}

function computePlusCode(lat, lon) {
    return OpenLocationCode.encode(parseFloat(lat), parseFloat(lon), 11);
}

function extractPlusCodes(points) {
    const codes = new Set();
    for (const point of points) {
        if (point.length >= 3 && point[1] && point[2]) {
            try {
                const code = computePlusCode(point[2], point[1]);
                codes.add(code);
            } catch {}
        }
    }
    return Array.from(codes);
}

async function saveTrack(trackId, trackData) {
    const date = trackData.date || "1970-01-01";
    const [year, month, day] = date.split("-");

    const dir = path.join("track/tracks", year, month, day);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, trackId + ".json");
    await fs.writeFile(filePath, JSON.stringify(trackData, null, 2), "utf8");

    return filePath;
}

async function saveSegment(trackId, segmentData) {
    const oid = crypto.createHash("sha256").update("segment" + segmentData.index + trackId).digest("hex");
    const dir1 = oid.substring(0, 2);
    const dir2 = oid.substring(2, 4);
    const dir = path.join("track/segments", dir1, dir2);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(dir, oid + ".json");
    await fs.writeFile(filePath, JSON.stringify(segmentData, null, 2), "utf8");

    return oid;
}

async function processTrackFile(args) {
    const { gitdir, commit, file, readerPool, gitea_host, token, processedTrackIds } = args;
    const ext = path.extname(file).toLowerCase();
    const basename = path.basename(file, ext);

    const trackId = computeTrackId(basename);
    if (processedTrackIds.has(trackId)) {
        return { skipped: true, file, trackId };
    }

    const reader = await readerPool.acquire();
    try {
        const lfsPointer = await getLfsPointerContent(reader, commit, file);

        let content;
        let oid;

        if (lfsPointer) {
            const binary = await downloadLfsFile(gitea_host, token, lfsPointer.oid);
            if (!binary) return null;
            content = new TextDecoder().decode(new Uint8Array(binary));
            oid = lfsPointer.oid;
        } else {
            const blob = await reader.get(commit + ":" + file);
            if (!blob) return null;
            content = blob.toString("utf8");
            oid = crypto.createHash("sha256").update(blob).digest("hex");
        }

        const points = parseTrack(content, ext);
        if (points.length === 0) return null;

        const date = getEarliestDate(points, ext);
        const segmentIds = [];

        for (let i = 0; i < points.length; i += SEGMENT_SIZE) {
            const segmentPoints = points.slice(i, i + SEGMENT_SIZE);
            const segmentData = {
                track_ident: trackId,
                index: Math.floor(i / SEGMENT_SIZE),
                seg: segmentPoints,
                keys: extractPlusCodes(segmentPoints)
            };
            const segId = await saveSegment(trackId, segmentData);
            segmentIds.push(segId);
        }

        const trackData = {
            filename: file,
            ident: trackId,
            commit: commit,
            segments: segmentIds
        };

        if (date) {
            trackData.date = date;
        }

        await saveTrack(trackId, trackData);
        processedTrackIds.add(trackId);

        return { processed: true, file, trackId, pointCount: points.length };

    } catch (e) {
        console.log("Error processing file:", e.message);
        return { error: true, file, message: e.message };
    } finally {
        readerPool.release(reader);
    }
}

async function processFilesParallel(gitdir, commit, files, readerPool, gitea_host, token, processedTrackIds) {
    const tasks = files.map(file => ({
        gitdir, commit, file, readerPool, gitea_host, token, processedTrackIds
    }));

    const results = [];
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(processTrackFile));
        results.push(...batchResults);

        const processed = batchResults.filter(r => r?.processed).length;
        const skipped = batchResults.filter(r => r?.skipped).length;
        const errors = batchResults.filter(r => r?.error).length;
        console.log(`  Progress: ${i + batch.length}/${files.length} (processed: ${processed}, skipped: ${skipped}, errors: ${errors})`);
    }

    return results;
}

async function walkTree(gitdir, commit, prefix = "") {
    const results = new Map();

    try {
        const output = await rungit(["ls-tree", "-r", "--name-only", commit, prefix || "."], gitdir);
        const files = output.split("\n").filter(e => e.trim());

        for (const file of files) {
            if (isTrackFile(file)) {
                const ext = path.extname(file).toLowerCase();
                const basename = path.basename(file, ext);

                if (!results.has(basename) || getPriority(file) < getPriority(results.get(basename))) {
                    results.set(basename, file);
                }
            }
        }
    } catch (e) {
        console.error("Error walking tree:", e);
    }

    return Array.from(results.values());
}

async function getAllRefs(gitdir) {
    const output = await rungit(["show-ref"], gitdir);
    const refs = {};
    const lines = output.split("\n");
    for (const line of lines) {
        const match = line.match(/^([0-9a-f]+) (.*)$/);
        if (match) {
            refs[match[2]] = match[1];
        }
    }
    return refs;
}

async function getCommitHistory(gitdir, ref, baseCommit, sinceSha1) {
    try {
        let output;
        if (sinceSha1) {
            output = await rungit(["rev-list", baseCommit, "^" + sinceSha1, "--format=%H"], gitdir);
        } else {
            output = await rungit(["rev-list", baseCommit, "--format=%H"], gitdir);
        }
        const commits = output.split("\n").filter(e => e.match(/^[0-9a-f]{40}$/));
        return commits;
    } catch {
        return [baseCommit];
    }
}

async function processRef(gitdir, ref, commit, readerPool, gitea_host, token, processedTrackIds, lastProcessedSha1) {
    console.log(`Processing ref: ${ref} (${commit})`);

    const commits = await getCommitHistory(gitdir, ref, commit, lastProcessedSha1);
    console.log(`Found ${commits.length} commits to process`);

    if (commits.length === 0) {
        console.log(`  No new commits to process`);
        return commit;
    }

    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let lastSha1 = lastProcessedSha1 || "";

    for (const commitHash of commits) {
        console.log(`  Processing commit: ${commitHash}`);

        const files = await walkTree(gitdir, commitHash);

        const results = await processFilesParallel(gitdir, commitHash, files, readerPool, gitea_host, token, processedTrackIds);

        totalProcessed += results.filter(r => r?.processed).length;
        totalSkipped += results.filter(r => r?.skipped).length;
        totalErrors += results.filter(r => r?.error).length;

        lastSha1 = commitHash;
    }

    console.log(`  Ref complete: processed: ${totalProcessed}, skipped: ${totalSkipped}, errors: ${totalErrors}`);

    return lastSha1;
}

async function main() {
    const { gitdir, gitea_host, tokenArg } = parseArgs();
    const token = await getToken(tokenArg);

    if (!gitea_host) {
        console.error("Error: --gitea-host is required");
        process.exit(1);
    }

    if (!token) {
        console.error("Error: token is required (gitea_token file or --token argument)");
        process.exit(1);
    }

    await fs.mkdir("track/tracks", { recursive: true });
    await fs.mkdir("track/segments", { recursive: true });

    const readerPool = make_reader_pool(gitdir, CONCURRENCY);
    const refs = await getAllRefs(gitdir);
    const processedTrackIds = await loadProcessedTrackIds();

    console.log(`Found ${Object.keys(refs).length} refs`);
    console.log(`Already processed: ${processedTrackIds.size} track IDs`);

    for (const [ref, commit] of Object.entries(refs)) {
        await processRef(gitdir, ref, commit, readerPool, gitea_host, token, processedTrackIds, null);
    }

    await readerPool.dispose();

    console.log("Done!");
}

main().catch(console.error);
