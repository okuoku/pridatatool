import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import child_process from "child_process";
import { extract_exif } from "./extract_exif.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".raw", ".cr2", ".nef", ".arw", ".dng", ".orf", ".rw2"]);

const STATUS_FILE = "save_status.txt";
const SAVE_DIR = "save";
const CONCURRENCY = 8;

function parseArgs(){
    const args = process.argv.slice(2);
    let gitdir = "photos.git";
    let gitea_host = null;
    let token = process.env.GITEA_TOKEN || null;

    for(let i = 0; i < args.length; i++){
        if(args[i] === "--gitdir" && i + 1 < args.length){
            gitdir = args[++i];
        }else if(args[i] === "--gitea-host" && i + 1 < args.length){
            gitea_host = args[++i];
        }else if(args[i] === "--token" && i + 1 < args.length){
            token = args[++i];
        }
    }

    if(!gitea_host){
        console.error("Error: --gitea-host is required");
        process.exit(1);
    }

    if(!token){
        console.error("Error: GITEA_TOKEN env var or --token argument is required");
        process.exit(1);
    }

    return { gitdir, gitea_host, token };
}

async function rungit(cmd, gitdir){
    return new Promise((resolve, reject) => {
        child_process.execFile("git", cmd, { cwd: gitdir }, (err, stdout, stderr) => {
            if(err){
                reject(err);
            }else{
                resolve(stdout.trim());
            }
        });
    });
}

function make_reader(gitdir){
    const child = child_process.spawn("git", ["cat-file", "--batch"], 
                                      { cwd: gitdir, stdio: ["pipe", "pipe", "inherit"] });

    let in_header = true;
    let headerbuf = [];
    let bodybuf = [];
    let bodysize = 0;
    let queuedsize = 0;
    let recv = null;
    let pendingError = null;

    child.stdout.on("data", (dat) => {
        function consumebody(buf){
            if((bodysize + 1) === queuedsize + buf.length){
                if(buf.length !== 1){
                    bodybuf.push(buf.subarray(0, buf.length - 1));
                }
                const out = Buffer.concat(bodybuf);
                bodybuf = [];
                queuedsize = 0;
                in_header = true;
                if(recv) recv(out);
            }else{
                bodybuf.push(buf);
                queuedsize += buf.length;
                if(queuedsize > bodysize){
                    pendingError = "size mismatch";
                }
            }
        }
        function parseheader(){
            const re = /([0-9a-f]+) blob ([0-9]+)/;
            const header = Buffer.concat(headerbuf).toString("utf8");
            headerbuf = [];
            const m = header.match(re);
            if(m){
                bodysize = parseInt(m[2]);
                in_header = false;
            }else{
                bodysize = 0;
            }
        }

        if(in_header){
            const lfidx = dat.indexOf(0x0a);
            if(lfidx === -1){
                headerbuf.push(dat);
            }else{
                if(lfidx !== 0){
                    headerbuf.push(dat.subarray(0, lfidx));
                }
                parseheader();
                if(bodysize !== false){
                    if(lfidx + 1 !== dat.length){
                        consumebody(dat.subarray(lfidx + 1, dat.length));
                    }
                }else{
                    if(recv) recv(false);
                }
            }
        }else{
            consumebody(dat);
        }
    });

    child.on("error", (e) => {
        pendingError = e;
    });

    return {
        get: async function(refpath){
            const writedata = refpath + "\n";
            return new Promise((resolve, reject) => {
                if(pendingError){
                    reject(pendingError);
                    return;
                }
                if(recv){
                    reject("overlapped");
                    return;
                }
                recv = function(blob){
                    recv = null;
                    resolve(blob);
                };
                child.stdin.write(writedata, "utf8");
            });
        },
        dispose: async function(){
            return new Promise((resolve) => {
                child.stdin.end(() => resolve());
            });
        }
    };
}

function isImageFile(filename){
    const ext = path.extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

async function loadProcessedRefs(){
    try{
        const content = await fs.readFile(STATUS_FILE, "utf8");
        const processed = new Map();
        for(const line of content.split("\n")){
            const trimmed = line.trim();
            if(!trimmed) continue;
            const [sha1, ...refParts] = trimmed.split(" ");
            const ref = refParts.join(" ");
            if(sha1 && ref){
                processed.set(ref, sha1);
            }
        }
        return processed;
    }catch{
        return new Map();
    }
}

async function saveProcessedRef(ref, sha1){
    await fs.appendFile(STATUS_FILE, `${sha1} ${ref}\n`, "utf8");
}

async function loadProcessedOids(){
    const processedOids = new Set();
    try{
        const entries = await fs.readdir(SAVE_DIR, { withFileTypes: true });
        for(const dir1 of entries){
            if(!dir1.isDirectory()) continue;
            const dir1Path = path.join(SAVE_DIR, dir1.name);
            const subEntries = await fs.readdir(dir1Path, { withFileTypes: true });
            for(const dir2 of subEntries){
                if(!dir2.isDirectory()) continue;
                const dir2Path = path.join(dir1Path, dir2.name);
                const files = await fs.readdir(dir2Path);
                for(const file of files){
                    if(file.endsWith(".json")){
                        const oid = file.replace(".json", "");
                        processedOids.add(oid);
                    }
                }
            }
        }
    }catch{
    }
    return processedOids;
}

async function getLfsPointerContent(reader, commit, filePath){
    try{
        const content = await reader.get(commit + ":" + filePath);
        if(!content) return null;
        
        const text = content.toString("utf8");
        const oidMatch = text.match(/^oid sha256:([a-f0-9]{64})/m);
        const sizeMatch = text.match(/^size (\d+)/m);
        
        if(oidMatch && sizeMatch){
            return {
                oid: oidMatch[1],
                size: parseInt(sizeMatch[1])
            };
        }
        return null;
    }catch{
        return null;
    }
}

async function downloadLfsFile(gitea_host, token, oid){
    const url = `${gitea_host}/git-lfs/objects/${oid}`;
    
    const response = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${token}`
        }
    });

    if(!response.ok){
        console.error(`Failed to download LFS file ${oid}: ${response.status}`);
        return null;
    }

    return await response.arrayBuffer();
}

async function saveExifData(oid, exifData){
    const dir1 = oid.substring(0, 2);
    const dir2 = oid.substring(2, 4);
    const subdir = path.join(SAVE_DIR, dir1, dir2);
    
    await fs.mkdir(subdir, { recursive: true });
    
    const filePath = path.join(subdir, oid + ".json");
    await fs.writeFile(filePath, JSON.stringify(exifData, null, 2), "utf8");
    
    return filePath;
}

async function walkTree(gitdir, commit, prefix = ""){
    const results = [];
    
    try{
        const output = await rungit(["ls-tree", "-r", "--name-only", commit, prefix || "."], gitdir);
        const files = output.split("\n").filter(e => e.trim());
        
        for(const file of files){
            if(isImageFile(file)){
                results.push(file);
            }
        }
    }catch(e){
        console.error("Error walking tree:", e);
    }
    
    return results;
}

async function getAllRefs(gitdir){
    const output = await rungit(["show-ref"], gitdir);
    const refs = {};
    const lines = output.split("\n");
    for(const line of lines){
        const match = line.match(/^([0-9a-f]+) (.*)$/);
        if(match){
            refs[match[2]] = match[1];
        }
    }
    return refs;
}

async function getCommitHistory(gitdir, ref, baseCommit, sinceSha1){
    try{
        let output;
        if(sinceSha1){
            output = await rungit(["rev-list", baseCommit, "^" + sinceSha1, "--format=%H"], gitdir);
        }else{
            output = await rungit(["rev-list", baseCommit, "--format=%H"], gitdir);
        }
        const commits = output.split("\n").filter(e => e.match(/^[0-9a-f]{40}$/));
        return commits;
    }catch{
        return [baseCommit];
    }
}

async function processFile(args){
    const { gitdir, commit, file, reader, gitea_host, token, processedOids } = args;
    
    try{
        const lfsPointer = await getLfsPointerContent(reader, commit, file);
        
        if(!lfsPointer){
            const content = await reader.get(commit + ":" + file);
            if(content && isImageFile(file)){
                const hash = crypto.createHash("sha256").update(content).digest("hex");
                if(processedOids.has(hash)){
                    return { skipped: true, file, hash };
                }
                const exif = await extract_exif(content);
                if(exif){
                    await saveExifData(hash, exif);
                    processedOids.add(hash);
                    return { processed: true, file, hash };
                }
            }
            return null;
        }
        
        if(processedOids.has(lfsPointer.oid)){
            return { skipped: true, file, hash: lfsPointer.oid };
        }
        
        const binary = await downloadLfsFile(gitea_host, token, lfsPointer.oid);
        if(binary){
            const bytes = new Uint8Array(binary);
            const exif = await extract_exif(bytes);
            
            if(exif){
                await saveExifData(lfsPointer.oid, exif);
                processedOids.add(lfsPointer.oid);
                return { processed: true, file, hash: lfsPointer.oid };
            }
        }
    }catch(e){
        return { error: true, file, message: e.message };
    }
    return null;
}

async function processFilesParallel(gitdir, commit, files, reader, gitea_host, token, processedOids){
    const tasks = files.map(file => ({
        gitdir, commit, file, reader, gitea_host, token, processedOids
    }));
    
    const results = [];
    for(let i = 0; i < tasks.length; i += CONCURRENCY){
        const batch = tasks.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(processFile));
        results.push(...batchResults);
        
        const processed = batchResults.filter(r => r?.processed).length;
        const skipped = batchResults.filter(r => r?.skipped).length;
        const errors = batchResults.filter(r => r?.error).length;
        console.log(`  Progress: ${i + batch.length}/${files.length} (processed: ${processed}, skipped: ${skipped}, errors: ${errors})`);
    }
    
    return results;
}

async function processRef(gitdir, ref, commit, reader, gitea_host, token, processedOids, lastProcessedSha1){
    console.log(`Processing ref: ${ref} (${commit})`);
    
    const commits = await getCommitHistory(gitdir, ref, commit, lastProcessedSha1);
    console.log(`Found ${commits.length} commits to process`);
    
    if(commits.length === 0){
        console.log(`  No new commits to process`);
        return commit;
    }
    
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let lastSha1 = lastProcessedSha1 || "";
    
    for(const commitHash of commits){
        console.log(`  Processing commit: ${commitHash}`);
        
        const files = await walkTree(gitdir, commitHash);
        
        const results = await processFilesParallel(gitdir, commitHash, files, reader, gitea_host, token, processedOids);
        
        totalProcessed += results.filter(r => r?.processed).length;
        totalSkipped += results.filter(r => r?.skipped).length;
        totalErrors += results.filter(r => r?.error).length;
        
        lastSha1 = commitHash;
    }
    
    console.log(`  Ref complete: processed: ${totalProcessed}, skipped: ${totalSkipped}, errors: ${totalErrors}`);
    
    await saveProcessedRef(ref, lastSha1);
    
    return lastSha1;
}

async function main(){
    const { gitdir, gitea_host, token } = parseArgs();
    
    await fs.mkdir(SAVE_DIR, { recursive: true });
    
    const reader = make_reader(gitdir);
    const refs = await getAllRefs(gitdir);
    const processedRefs = await loadProcessedRefs();
    const processedOids = await loadProcessedOids();
    
    console.log(`Found ${Object.keys(refs).length} refs`);
    console.log(`Already processed: ${processedRefs.size} refs, ${processedOids.size} OIDs`);
    
    for(const [ref, commit] of Object.entries(refs)){
        const lastProcessedSha1 = processedRefs.get(ref);
        if(lastProcessedSha1){
            console.log(`Skipping already processed ref: ${ref} (up to ${lastProcessedSha1})`);
            continue;
        }
        
        await processRef(gitdir, ref, commit, reader, gitea_host, token, processedOids, null);
    }
    
    await reader.dispose();
    
    console.log("Done!");
}

main().catch(console.error);
