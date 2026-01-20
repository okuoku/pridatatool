import zlib from "node:zlib";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

function check_dir(pth){
    return new Promise((res, rej) => {
        fs.stat(pth, (err, stats) => {
            if(err){
                res(false);
            }else{
                res(stats.isDirectory());
            }
        });
    });
}

function mkdir(pth){
    return new Promise((res, rej) => {
        fs.mkdir(pth, {recursive: true}, (err, path) => {
            if(err){
                rej(err);
            }else{
                res(true);
            }
        });
    });
}

function tryopen(pth){
    return new Promise((res, rej) => {
        fs.open(pth, "wx", (err, fd) => {
            if(err){
                res(false);
            }else{
                res(fd);
            }
        });
    });
}

function trywrite_and_close(fd, obj){
    return new Promise((res, rej) => {
        fs.write(fd, obj, 0, (err, wrt, buf) => {
            if(err){
                rej("unexpected");
            }
            if(wrt != obj.length){
                rej("unexpected");
            }
            fs.close(fd, (err) =>{
                res(true);
            });
        });
    });
}

async function save(prefix, buf0){
    const buf = Buffer.from(buf0);
    const len = buf.length;
    const h = crypto.createHash("sha1");
    const hdr = Buffer.from("blob " + len.toString() + "\0");
    h.update(hdr);
    h.update(buf);
    const hash = h.digest("hex");
    const h0 = hash.substring(0, 2);
    const h1 = hash.substring(2);
    let dir = "";
    const sobjdir0 = prefix + path.sep + ".git" + path.sep + "objects";
    const sobjdir1 = prefix + path.sep + "objects";
    const s0 = await check_dir(sobjdir0);
    const s1 = await check_dir(sobjdir1);
    if(s0){
        dir = sobjdir0;
    }else if(s1){
        dir = sobjdir1;
    }else{
        throw "unexpected";
    }

    dir = dir + path.sep + h0;
    await mkdir(dir);

    const pth = dir + path.sep + h1;
    console.log("Trying", pth);
    const fd = await tryopen(pth);
    if(fd == false){
        /* Assume we already have actual content in the DB */
    }else{
        const content = Buffer.concat([hdr, buf]);
        const output = zlib.deflateSync(content, {level: 0});
        await trywrite_and_close(fd, output);
    }
    return hash;
}

export default{
    save: save
};
