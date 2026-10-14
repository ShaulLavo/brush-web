// Added only to frozen benchmark worker copies. Production workers remain untouched.
export const workerInstrumentation = String.raw`
const originalStore=Atomics.store;
const originalInstantiate=WebAssembly.instantiate;
let activeProfile;
let profileSequence=0;
Atomics.store=function(array,index,value){
  if(index===11 && array.length===16){
    if(value===2)activeProfile={sequence:++profileSequence,started:performance.now(),hostMs:0,reads:0,writes:0,oneByteReads:0,readBytes:0,writeBytes:0,fileCopiedBytes:0,fileAllocatedBytes:0,outputPeakBytes:0};
    if((value===1||value===3) && activeProfile){
      const done=activeProfile;activeProfile=undefined;
      postMessage({performanceSample:{...done,elapsedMs:performance.now()-done.started}});
    }
  }
  const result=originalStore(array,index,value);
  if(index===2 && array.length===16 && activeProfile)activeProfile.outputPeakBytes=Math.max(activeProfile.outputPeakBytes,(value-Atomics.load(array,3))>>>0);
  return result;
};
WebAssembly.instantiate=async function(module,imports){
  if(!globalThis.__profileIO)return originalInstantiate.call(WebAssembly,module,imports);
  let memory;
  const positions=new Map();
  const sizes=new Map();
  const sys=imports.wasi_snapshot_preview1;
  for(const name of Object.keys(sys)){
    const fn=sys[name];
    sys[name]=(...args)=>{
      const profile=activeProfile;
      const start=profile?performance.now():0;
      const result=fn(...args);
      if(profile)profile.hostMs+=performance.now()-start;
      if(!memory)return result;
      const view=new DataView(memory.buffer);
      if(name==='path_open' && result===0){
        const [fd,flags,ptr,len,oflags,rights,inherited,fdflags,out]=args;
        const path=new TextDecoder().decode(new Uint8Array(memory.buffer,ptr,len));
        if(oflags&8)sizes.set(path,0);
        positions.set(view.getUint32(out,true),{path,position:fdflags&1?(sizes.get(path)??0):0});
      }
      if(name==='fd_close')positions.delete(args[0]);
      if(!profile || result!==0)return result;
      if(name==='fd_read'){
        const [fd,ptr,count,out]=args;
        const bytes=view.getUint32(out,true);
        profile.reads++;profile.readBytes+=bytes;
        if(count===1 && view.getUint32(ptr+4,true)===1)profile.oneByteReads++;
        const entry=positions.get(fd);if(entry)entry.position+=bytes;
      }
      if(name==='fd_write'){
        const [fd,ptr,count,out]=args;
        profile.writes++;profile.writeBytes+=view.getUint32(out,true);
        const entry=positions.get(fd);
        if(entry){
          let size=sizes.get(entry.path)??0;
          for(let i=0;i<count;i++){
            const bytes=view.getUint32(ptr+i*8+4,true);
            const end=entry.position+bytes;
            if(end>size){profile.fileCopiedBytes+=size;profile.fileAllocatedBytes+=end;size=end;}
            entry.position=end;
          }
          sizes.set(entry.path,size);
        }
      }
      return result;
    };
  }
  const instance=await originalInstantiate.call(WebAssembly,module,imports);
  memory=instance.exports.memory;
  return instance;
};
`;
export const browserInstrumentation = () => {
  window.performanceSamples = [];
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", ({ data }) => {
        if (data?.performanceSample) window.performanceSamples.push(data.performanceSample);
      });
    }
  };
};
