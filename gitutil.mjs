import fs from "fs";
import path from "node:path";
import process from "node:process";
import child_process from "child_process";
import stream from "node:stream";
import gitblob from "./gitblob.mjs";

async function rungit_stdin(cmd, gitdir, env, buf){
    const myenv = {};
    for(const k in process.env){
        myenv[k] = process.env[k];
    }
    for(const k in env){
        myenv[k] = env[k];
    }

    const opt = {
        cwd: gitdir,
        env: myenv,
        stdio: ["pipe", "pipe", "inherit"]
    };

    let outbuf = "";
    const p = new Promise((res, rej) => {
        const child = child_process.spawn("git", cmd, opt);

        child.on("error", (e) => {
            rej(e);
        });

        child.stdout.setEncoding("utf8");

        // outbuf handler
        child.stdout.on("data", (e) => {
            outbuf += e;
        });
        child.stdout.on("close", () => {
            // Return buffer
            res(outbuf.trim());
        });

        // Write stdin
        child.stdin.end(buf);
    });

    const ret = await p;
    return ret;
}

async function rungit(cmd, gitdir, env){
    const myenv = {};
    for(const k in process.env){
        myenv[k] = process.env[k];
    }
    for(const k in env){
        myenv[k] = env[k];
    }

    const p = new Promise((res, rej) => {
        child_process.execFile("git", cmd,
                               {cwd: gitdir, env: myenv},
                               (err, stdout, stderr) => {
                                   if(! err){
                                       res(stdout.trim());
                                   }else{
                                       rej(err);
                                   }
                               });
    });

    const ret = await p;
    return ret;
}

function make_writer(gitdir, index_name){
    let currentref = "HEAD"; // FIXME: Resolve this into real ref
    let index_file = false;

    function procdate(obj){
        if(typeof obj == "string"){
            return obj;
        }else{
            return obj.toString();
        }
    }

    if(index_name){
        // Resolve index_name into an absolute path
        if(path.isAbsolute(index_name)){
            index_file = index_name;
        }else{
            index_file = process.cwd() + path.sep + index_name;
        }
    }
    return {
        init: async function(ref){
            // git read-tree $ref
            if(ref){
                currentref = ref;
            }

            await rungit(["read-tree", currentref], gitdir,
                         {GIT_INDEX_FILE: index_file});
            return true;
        },
        hash: async function(obj){
            /*
            // git hash-object -w --stdin < $obj > $hash
            const hash = await rungit_stdin(["hash-object", "-w", "--stdin"], 
                                            gitdir, {}, obj);
                                            */
            const hash = gitblob.save(gitdir, obj);
            return hash;
        },
        bulkset: async function(cmd){
            // cmd = [{path: "xxx", hash: "yyy"}, ...]
            const cvt = cmd.map((e) => 
                                { return "10064 " + e.hash + " 0\t" + e.path + "\n"; });
            const info = cvt.join("");
            // git update-index --add --index-info < $info
            await rungit_stdin(["update-index", "--add", "--index-info"],
                               gitdir, {GIT_INDEX_FILE: index_file}, info);
        },
        set: async function(path, obj){
            // git hash-object -w --stdin < $obj > $hash
            // git update-index --add --cacheinfo 100644,$hash,$path
            const hash = await rungit_stdin(["hash-object", "-w", "--stdin"], 
                                            gitdir, {}, obj);
            const ci = "100644," + hash + "," + path;

            console.log("update", ci);
            await rungit(["update-index", "--add", "--cacheinfo",
                ci], gitdir, {GIT_INDEX_FILE: index_file});
        },
        unset: async function(path){
            // git rm -f --cached --ignore-unmatch path
            await rungit(["rm", "-f", "--cached", "--ignore-unmatch", path], 
                         gitdir, {GIT_INDEX_FILE: index_file});
        },
        read_tree: async function(prefix, obj){
            if(prefix){
                /* NB: --prefix= requires work tree */
                await rungit(["read-tree", "--prefix=" + prefix, obj], 
                             gitdir, 
                             {GIT_WORK_TREE: gitdir, GIT_INDEX_FILE: index_file});
            }else{
                await rungit(["read-tree", obj], 
                             gitdir, {GIT_INDEX_FILE: index_file});
            }
        },
        commit: async function(opts){
            // git write-tree > $tree
            // git commit-tree $tree -p currentref -m "$opts.msg" > $newref
            // git update-ref $currentref $newref

            const now = new Date();
            const msg = opts.msg ? opts.msg : "Update";
            let commitopts = {
                GIT_AUTHOR_EMAIL: opts.email ? opts.email : "nobody",
                GIT_AUTHOR_NAME: opts.name ? opts.name : "nobody",
                GIT_AUTHOR_DATE: opts.date ? procdate(opts.date) : procdate(now),
                GIT_COMMITTER_EMAIL: opts.committer_email ? opts.committer_email : "nobody",
                GIT_COMMITTER_NAME: opts.committer_name ? opts.committer_name : "nobody",
                GIT_COMMITTER_DATE: opts.commiter_date ? procdate(opts.committer_date) : procdate(now)
            };
            const tree = await rungit(["write-tree"], gitdir, 
                {GIT_INDEX_FILE: index_file});

            if(currentref){
                const newref = await rungit(["commit-tree", tree, "-p", currentref,
                    "-m", msg], gitdir, commitopts);
                await rungit(["update-ref", currentref, newref], gitdir, {});
                return newref;
            }else{
                const newref = await rungit(["commit-tree", tree,
                    "-m", msg], gitdir, commitopts);
                return newref;
            }
        },
        dispose: async function(){
            if(index_file){
                // rm $index_file
                const p = new Promise((res, rej) => {
                    fs.rm(index_file, {force: false}, (err) => {
                        // Ignore error
                        res();
                    });
                });
                await p;
            }
            return true;
        }
    };
}

function make_reader(gitdir){
    let errstate = false;
    let recv = false;
    const child = child_process.spawn("git", ["cat-file", "--batch"], 
                                      {cwd: gitdir, stdio: ["pipe", "pipe", "inherit"]});


    child.on("error", () => {
        errstate = true;
        child = null;
    });

    let in_header = true;
    let headerbuf = [];
    let bodybuf = [];
    let bodysize = 0;
    let queuedsize = 0;
    child.stdout.on("data", (dat) => {
        function consumebody(buf){
            if((bodysize + 1) == queuedsize + buf.length){
                if(buf.length != 1){
                    bodybuf.push(buf.subarray(0, buf.length - 1));
                }
                const out = Buffer.concat(bodybuf);
                bodybuf = [];
                queuedsize = 0;
                in_header = true;
                recv(out);
            }else{
                bodybuf.push(buf);
                queuedsize += buf.length;
                if(queuedsize > bodysize){
                    throw "something wrong";
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
            // Read to LF
            const lfidx = dat.indexOf(0x0a /* LF */);
            if(lfidx == -1){
                // Partial header
                headerbuf.push(dat);
            }else{
                if(lfidx != 0){
                    headerbuf.push(dat.subarray(0, lfidx));
                }
                parseheader(); // should now have bodysize
                if(bodysize != false){
                    if(lfidx+1 != dat.length){
                        consumebody(dat.subarray(lfidx + 1, dat.length));
                    }
                }else{
                    // error. Return false as data
                    recv(false);
                }
            }
        }else{
            consumebody(dat);
        }
    });


    return {
        get: async function(ref, path){
            const writedata = ref + ":" + path + "\n";
            return new Promise((res, rej) => {
                if(recv){
                    rej("overlapped");
                }else{
                    recv = function(blob){
                        recv = false;
                        res(blob);
                    };
                    child.stdin.write(writedata, "utf8");
                }
            });
        },
        dispose: async function(){
            return new Promise((res, rej) => {
                child.stdin.end(x => res());
            });
        }
    }
}

function make_enumerator(gitdir){
    return {
        refs: async function(){
            const r = await rungit(["show-ref"], gitdir, {});
            const a = r.split("\n");
            let out = {};
            const m = a.forEach(e => {
                const re = /([0-9a-f]+) (.*)/;
                const m = e.match(re);
                if(!m){
                    throw "unexpected";
                }
                out[m[2]] = m[1];
            });
            return out;
        },
        history_linear: async function(a, b){
            // Dump history a to b, excluding a, including b (first parent only)
            const r = await rungit(["rev-list", "--first-parent", "--no-commit-header", "--format=%H", a + ".." + b], gitdir, {});
            return r.split("\n");
        },
        commit_info: async function(commit){
            const r = await rungit(["show", "--format=%an%x09%ae%x09%aI%n%cn%x09%ce%x09%cI%n%T%n%B", "-s", commit], gitdir, {});
            const re = /([^\t]*)\t([^\t]*)\t([^\n]*)\n([^\t]*)\t([^\t]*)\t([^\n]*)\n([^\n]*)\n(.*)/;
            const m = r.match(re);
            if(! m){
                return false;
            }else{
                return {
                    name: m[1],
                    email: m[2],
                    date: m[3],
                    committer_name: m[4],
                    committer_email: m[5],
                    committer_date: m[6],
                    tree: m[7],
                    msg: m[8]
                };
            }
        },
        diff: async function(a,b){
            const re1 = /:([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) ([CR])([0-9]*)\t([^\t]+)\t([^\t]+)/;
            const re2 = /:([^ ]+) ([^ ]+) ([^ ]+) ([^ ]+) (.)\t(.+)/;

            const r = await rungit(["diff", "--no-abbrev", "--raw", a, b],
                                   gitdir, {});
            const o = r.split("\n");
            const x = o.map(e => {
                const m1 = e.match(re1);
                const m2 = e.match(re2);
                if(m1){
                    /* Rename or Copy */
                    const from = m1[3];
                    const to = m1[4];
                    const op = m1[5];
                    const index = m1[6];
                    const path_from = m1[7];
                    const path_to = m1[8];
                    return {
                        from: from,
                        to: to,
                        op: op,
                        index: index,
                        path_orig: path_from,
                        path: path_to
                    };
                }else if(m2){
                    /* Other ops */
                    const from = m2[3];
                    const to = m2[4];
                    const op = m2[5];
                    const path = m2[6];
                    return {
                        from: from,
                        to: to,
                        op: op,
                        path: path
                    };
                }else{
                    throw "unexpected";
                }
            });
            return x;

        },
        empty_commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    };
}

function make_remotemanager(gitdir){
    return {
        getnode: async function(commit, path){ /* => {type, ident} / #f */
            const r = await rungit(["ls-tree", "--no-abbrev", 
                "--format=%(objecttype) %(objectname)", 
                commit, path], gitdir, {});
            if(r == ""){
                return false;
            }else{
                const p = r.split(" ");
                return {
                    type: p[0],
                    ident: p[1]
                }
            }
        },
        getmodulepaths: async function(commit /* Must have .gitmodules */){
            const r = await rungit(["config", "--blob", commit + ":" + 
                ".gitmodules", "--get-regexp", "submodule.*.path"],
            gitdir, {});
            const o = r.split("\n");
            const x = o.map(e => {
                const p = e.split(" ");
                const name = p[0].replace("submodule.","")
                    .replace(".path","")
                    .replaceAll("/", "_");
                return {
                    name: name,
                    path: p[1]
                };
            });
            return x;
        },
        genconfig: async function(commit /* Must have .gitmodules */){
            /* FIXME: Support relative path against origin */
            const r = await rungit(["config", "--blob", commit + ":" + 
                ".gitmodules", "--get-regexp", "submodule.*.url"],
            gitdir, {});
            const o = r.split("\n");
            const x = o.map(e => {
                const p = e.split(" ");
                const name = p[0].replace("submodule.","")
                    .replace(".url","")
                    .replaceAll("/", "_");
                return {
                    name: name,
                    url: p[1]
                };
            });
            return x;
        },
        setup_config: async function(cfg /* {name, url} */){
            for(const k in cfg){
                const c = cfg[k];
                const cfgname = "remote." + c.name;
                await rungit(["config", cfgname + ".tagOpt", "--no-tags"], 
                             gitdir, {});
                await rungit(["config", cfgname + ".url", c.url], gitdir, {});
                await rungit(["config", cfgname + ".fetch", "+refs/heads/*:" +
                    "refs/heads/" + c.name + "/*"], gitdir, {});
            }
        },
        do_fetch: async function(cfg){
            const params = ["fetch", "--prune", "--no-tags", "--multiple", 
                "--jobs", "8"];
            const args = params.concat(cfg.map(e => e.name));
            console.log(args);
            await rungit(args, gitdir, {});
        }
    }
}

export default {
    make_writer: make_writer,
    make_reader: make_reader,
    make_enumerator: make_enumerator,
    make_remotemanager: make_remotemanager
};
