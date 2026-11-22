import test from 'node:test';
import assert from 'node:assert/strict';
import { getFrame, matchStacks } from '../web/client.js';

const stack = (offset, uid='ref') => ({frameOfReference:uid, orientation:[1,0,0,0,1,0], volume:true, frames:[0,3,6,9].map(z => ({position:[0,0,z+offset]}))});

test('links the nearest physical slice, even in reverse order, without extrapolating', () => {
  const a=stack(0), b=stack(1); b.frames.reverse();
  const link=matchStacks(a,b);
  assert.equal(link(0),3); assert.equal(link(2),1);
  assert.equal(matchStacks(a,stack(9))(0), null);
});
test('does not link unregistered, orthogonal, missing-geometry, or nonvolumetric series', () => {
  for (const other of [stack(0,'wrong'), {...stack(0),orientation:[0,1,0,0,0,1]}, {...stack(0),frames:[{}]}, {...stack(0),volume:false}, {...stack(0),frameOfReference:''}]) {
    assert.equal(matchStacks(stack(0),other), null);
  }
});
test('decodes signed CT values and spacing without silently padding a truncated frame', async () => {
  const headers={'X-Type':'f32','X-Width':'2','X-Height':'1','X-Window-Center':'0','X-Window-Width':'400','X-Invert':'0','X-Pixel-Spacing':'0.5,0.75'};
  const body=new Float32Array([-1024,120]);
  const f=await getFrame('s','f',undefined,async()=>new Response(body,{headers}));
  assert.deepEqual([...f.pixels],[-1024,120]); assert.equal(f.center,0); assert.equal(f.widthWindow,400); assert.deepEqual(f.spacing,[0.5,0.75]);
  await assert.rejects(getFrame('s','f',undefined,async()=>new Response(body.buffer.slice(0,4),{headers})),/length|incomplete/i);
});
test('keeps color pixels in interleaved RGB and distinguishes unknown scale from 1 mm', async () => {
  const headers={'X-Type':'rgb','X-Width':'1','X-Height':'1'};
  const f=await getFrame('s','f',undefined,async()=>new Response(new Uint8Array([56,111,200]),{headers}));
  assert.equal(f.spacing,null); assert.deepEqual([...f.pixels],[56,111,200]);
  await assert.rejects(getFrame('s','f',undefined,async()=>new Response('Not found',{status:404})),/404/);
});
