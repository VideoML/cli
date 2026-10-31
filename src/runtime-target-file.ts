import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import {resolve} from 'node:path';
/** Read a bounded data-only descriptor from a regular file without following its final symlink. */
export function readRuntimeTarget(path:string):unknown {
  if(typeof constants.O_NOFOLLOW!=='number'||typeof constants.O_NONBLOCK!=='number')
    throw new Error('BUNDLE_RUNTIME_TARGET: safe descriptor reading unavailable');
  let fd:number;
  try{fd=openSync(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){throw new Error(`BUNDLE_RUNTIME_TARGET: cannot open descriptor: ${String(error)}`);}
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size>1024*1024)throw new Error('BUNDLE_RUNTIME_TARGET: descriptor must be a regular file at most 1 MiB');
    const bytes=Buffer.alloc(1024*1024+1);let offset=0,n=0;
    while(offset<bytes.length&&(n=readSync(fd,bytes,offset,bytes.length-offset,null))>0)offset+=n;
    const after=fstatSync(fd);
    if(offset!==stat.size||offset>1024*1024||after.dev!==stat.dev||after.ino!==stat.ino||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('BUNDLE_RUNTIME_TARGET: descriptor changed or exceeded limit');
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,offset)));}catch{throw new Error('BUNDLE_RUNTIME_TARGET: malformed descriptor JSON');}
  } finally {closeSync(fd);}
}
