export async function json(url, options) {
  const res = await fetch(url, {cache:'no-store', ...options});
  if (!res.ok) {
    let detail; try { detail = (await res.json()).detail; } catch { /* No JSON error body. */ }
    throw new Error(typeof detail === 'string' ? detail : `The server returned HTTP ${res.status}.`);
  }
  return res.json();
}

export async function getFrame(session, id, signal, request=fetch) {
  const r = await request(`/api/frame/${encodeURIComponent(session)}/${encodeURIComponent(id)}`, {signal, cache:'no-store'});
  if (!r.ok) throw new Error(`Could not load this image (HTTP ${r.status}).`);
  const h = key => r.headers.get(`X-${key}`);
  const number = (key, fallback) => h(key) && Number.isFinite(Number(h(key))) ? Number(h(key)) : fallback;
  const width=number('Width',0), height=number('Height',0), type=h('Type');
  if (![width,height].every(x=>Number.isSafeInteger(x)&&x>0) || !['f32','rgb'].includes(type)) throw new Error('Unsupported frame dimensions or type.');
  const b=await r.arrayBuffer();
  if (b.byteLength!==width*height*(type==='f32'?4:3)) throw new Error('Incomplete frame: unexpected byte length.');
  const scale = (h('Pixel-Spacing') || '').split(',').map(Number);
  return {width,height,type,pixels:type==='f32'?new Float32Array(b):new Uint8Array(b),
    center:number('Window-Center',40),widthWindow:number('Window-Width',400),invert:h('Invert')==='1',
    spacing:scale.length===2 && scale.every(n=>Number.isFinite(n)&&n>0)?scale:null};
}

// Match plane positions in patient coordinates. No registration is inferred from anatomy or date.
export function matchStacks(a,b) {
  const finite=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
  const cross=([x,y,z,u,v,w])=>[y*w-z*v,z*u-x*w,x*v-y*u];
  const dot=(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0);
  if (![a,b].every(s=>s?.volume && finite(s.orientation,6) && s.frames.length>=2 && s.frames.every(f=>finite(f.position,3))) || !a.frameOfReference || a.frameOfReference!==b.frameOfReference) return null;
  const n=cross(a.orientation), other=cross(b.orientation);
  if (Math.abs(dot(n,other))<0.999) return null;
  const target=b.frames.map((f,index)=>({z:dot(f.position,n),index})).sort((l,r)=>l.z-r.z);
  const halfStep=(target.at(-1).z-target[0].z)/(2*(target.length-1));
  if (!(halfStep>0)) return null;
  return i=>{
    if (!a.frames[i]) return null;
    const z=dot(a.frames[i].position,n);
    let best=target[0];
    for (const f of target) if (Math.abs(f.z-z)<Math.abs(best.z-z)) best=f;
    return Math.abs(best.z-z)<=halfStep+1e-4 ? best.index : null;
  };
}
