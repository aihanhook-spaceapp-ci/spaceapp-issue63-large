import { createHash } from "node:crypto";
/** Unicode lexical tokenizer v1: words/numbers and each non-space punctuation.
 * These are fixture tokens, not any provider's tokens. No bytes/4 estimation.
 */
export function fixtureTokens(text) { return [...text.matchAll(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)].length; }
export function fixtureLine(index) {
  return `SRM:${String(index).padStart(6,"0")} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda μνήμη 中文 🙂 e\u0301 literal 38;2;255;0;0`;
}
export function fixtureManifest() {
  const hash=createHash("sha256"), checkpoints=[]; let tokens=0,bytes=0,next=0;
  const targets=[10000,25000,50000,75000];
  for(let i=1;i<=6000;i++) {
    const line=fixtureLine(i)+"\n"; tokens+=fixtureTokens(line);bytes+=Buffer.byteLength(line);hash.update(line);
    while(next<targets.length&&tokens>=targets[next])checkpoints.push({targetTokens:targets[next++],line:i,tokens});
  }
  return {version:1,tokenizer:"space-fixture-unicode-lexical-v1",providerTokens:false,logicalLines:6000,tokens,bytes,digest:hash.digest("hex"),checkpoints,maxBytes:16*1024*1024,maxDurationMs:180000};
}
// The fixed process waits for the browser proof before producing output. No shell,
// paths, prompts or executable input accepted; any other input is ignored.
export function fixtureProgram() {
  const manifest=fixtureManifest();
  return `(${fixtureProcess.toString()})(${JSON.stringify(manifest)},${fixtureLine.toString()})`;
}
async function fixtureProcess(manifest,line) {
  const {once}=await import('node:events');
  process.stdin.setRawMode?.(true);process.stdin.resume();
  let bytes=0,started=false,input='';
  const limit=setTimeout(()=>process.exit(2),manifest.maxDurationMs); limit.unref();
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const write=async data=>{const b=Buffer.isBuffer(data)?data:Buffer.from(data);bytes+=b.length;if(bytes>manifest.maxBytes)process.exit(2);if(!process.stdout.write(b))await once(process.stdout,'drain');};
  await write('SPACE_RENDER_READY\r\n');
  const run=async()=>{
    for(let i=1;i<=6000;i++) {
      const data=Buffer.from('\x1b[38;2;80;190;240m'+line(i)+'\x1b[0m\r\n');
      // Intentionally split CSI and multi-byte UTF-8 boundaries at the producer.
      const split=data.indexOf(Buffer.from('μ'))+1;
      await write(data.subarray(0,3));await write(data.subarray(3,split));await write(data.subarray(split));
      if(i%64===0)await sleep(100);
      if(i===1200){await write('\x1b[?1049h\x1b[2J\x1b[HSPACE_ALT_SCREEN\x1b[?1049l');await sleep(3500);}
      if(i===2400){await write('\x1b[?2026hSPACE_SYNCHRONIZED\r\x1b[2K');await sleep(250);await write('\x1b[?2026l');}
    }
    await write('SRD:'+manifest.digest+'\r\n');
    await sleep(200);
    await write('\x1b[2J\x1b[HSPACE_RENDER_FINAL '+manifest.digest+'\r\nGreek: μνήμη CJK: 中文 emoji: 🙂 combining: é\r\nLiteral ANSI example: 38;2;255;0;0\r\nSPACE_RENDER_COMPLETE\r\n');
  };
  process.stdin.on('data',data=>{input=(input+data.toString()).slice(-128);if(!started&&input.includes('SPACE_RENDER_START')){started=true;void run().catch(()=>process.exit(2));}});
}
export function createFixtureStreamVerifier(manifest=fixtureManifest()) {
  let tail='',last=0,missing=0,duplicates=0,outOfOrder=0,digest=null,bytes=0,overflow=false;
  const seen=new Uint8Array(manifest.logicalLines+1),hash=createHash('sha256');let corrupted=0;
  return {
    push(data) {
      bytes+=Buffer.byteLength(data);if(bytes>manifest.maxBytes){overflow=true;return;}
      const text=tail+data; const end=text.lastIndexOf('\n');if(end<0){tail=text.slice(-4096);return;}
      for(const match of text.slice(0,end+1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').matchAll(/SRM:(\d{6})([^\r\n]*)|SRD:([a-f0-9]{64})/g)) {
        if(match[3]){digest=match[3];continue;}
        const n=Number(match[1]);if(n<1||n>manifest.logicalLines){outOfOrder++;continue;}
        const actual='SRM:'+match[1]+match[2];if(actual!==fixtureLine(n))corrupted++;hash.update(actual+'\n');
        if(seen[n])duplicates++;if(n<last)outOfOrder++;seen[n]=1;last=n;
      }
      tail=text.slice(end+1).slice(-4096);
    },
    result(){missing=manifest.logicalLines-seen.reduce((a,b)=>a+b,0);return {ok:!overflow&&!missing&&!duplicates&&!outOfOrder&&!corrupted&&digest===manifest.digest&&hash.copy().digest('hex')===manifest.digest,missing,duplicates,outOfOrder,corrupted,bytes,overflow,digestMatches:digest===manifest.digest&&hash.copy().digest('hex')===manifest.digest,lastMarker:last};}
  };
}
