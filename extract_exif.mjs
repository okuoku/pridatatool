import {parseMetadata} from "@uswriting/exiftool";
import {readFile, writeFile} from "node:fs/promises";

let counter = 0;

function filt(obj){
    /* Binaries */
    delete obj.MPImage2;
    delete obj.ThumbnailImage;
    delete obj.GainMapImage;
    delete obj.ImageData;
    delete obj.HDRPlusMakerNote;

    /* Filesystem data */
    delete obj.SourceFile;
    delete obj.FileName;
    delete obj.FileModifyDate;
    delete obj.FileAccessDate;
    delete obj.FileInodeChangeDate;
    delete obj.FilePermissions;
    delete obj.Directory;

    return obj;
}

export async function extract_exif(bytes){
    counter++;
    const fil = {
        name: "inputfile" + counter.toString(),
        data: bytes
    };
    const params = {
        args: ["-json", "-n", "-b"],
        transform: (x) => JSON.parse(x)
    };
    const res = await parseMetadata(fil, params);
    if(res.success){
        return filt(res.data[0]);
    }else{
        return false;
    }
}

