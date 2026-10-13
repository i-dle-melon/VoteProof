import {deflateSync} from 'node:zlib';
const crc32=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
function chunk(name,bytes){const kind=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([kind,bytes])));return Buffer.concat([len,kind,bytes,crc]);}
function png(color,level){const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
 const row=Buffer.from([0,...color,...color]),pixels=Buffer.concat([row,row]);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels,{level})),chunk('IEND',Buffer.alloc(0))]);}
export function exactProofCorpus(){
 const base=png([255,0,0,255],0),different=png([0,0,255,255],0),oneByte=Buffer.from(base);oneByte[oneByte.length-1]^=1;
 return {original:{name:'proof.png',bytes:base},identical:{name:'proof.png',bytes:Buffer.from(base)},renamed:{name:'renamed.png',bytes:Buffer.from(base)},
   different_name_metadata:{name:'other.png',client_label:'different metadata',bytes:Buffer.from(base)},equal_size_different:{name:'blue.png',bytes:different},
   one_byte:{name:'one-byte.png',bytes:oneByte},reencoded_visual_equivalent:{name:'red-compressed.png',bytes:png([255,0,0,255],9)}};
}
