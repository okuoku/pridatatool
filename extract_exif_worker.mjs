import {parseMetadata} from "@uswriting/exiftool";

let counter = 0;

function filt(obj){
    delete obj.MPImage2;
    delete obj.ThumbnailImage;
    delete obj.GainMapImage;
    delete obj.ImageData;
    delete obj.HDRPlusMakerNote;
    delete obj.SourceFile;
    delete obj.FileName;
    delete obj.FileModifyDate;
    delete obj.FileAccessDate;
    delete obj.FileInodeChangeDate;
    delete obj.FilePermissions;
    delete obj.Directory;
    return obj;
}

async function extract_exif(bytes){
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

process.on("message", async (data) => {
    try{
        if(!data || !data.bytes || !Array.isArray(data.bytes)){
            process.send({ id: data?.id, error: "Invalid input data" });
            return;
        }
        const bytes = new Uint8Array(data.bytes);
        const result = await extract_exif(bytes);
        process.send({ id: data.id, result });
    }catch(e){
        process.send({ id: data?.id, error: e.message });
    }
});
