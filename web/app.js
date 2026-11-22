import { getFrame, json, matchStacks } from './client.js';

const $ = s=>document.querySelector(s);
const make = (tag, text, cls)=>{const e=document.createElement(tag); if (text!==undefined) e.textContent=text; if (cls) e.className=cls; return e;};
const state={session:null, studies:[], study:null, series:null, mode:'slice', second:null,positions:new Map(),annotationStore:new Map()};
let renderLife, importLife;
const library={writable:false, studies:[], generation:0, listLife:null, openLife:null, uploadLife:null, busy:null};

function dialog(title, nodes) {
  $('#info-title').textContent=title; $('#info-body').replaceChildren(...nodes);
  if (!$('#info-dialog').open) $('#info-dialog').showModal();
}
$('#close-info').onclick=()=>$('#info-dialog').close();
$('#help').onclick=()=>dialog('Quick guide',[
  make('p','Open one or more original DICOM files. For an imaging disc, choose its IMAGE folder or open the configured library. A DICOMDIR alone contains an index, not the scans.'),
  make('p','Pick an exam and a series in the exam browser. In 2D you can scroll through slices, adjust contrast and use measurement tools. Open Exam details to see the study and series information.'),
  make('p','Explore in 3D opens a rotatable 3D view of the selected series when it has consistent slice positions. Use its Explore sections control for linked cross-sections from three directions. The original 2D slices remain available at any time. A single X-ray or a set of untracked ultrasound images does not define a 3D volume.'),
  make('p','Compare puts two series side by side. Link slice positions matches slices by their recorded coordinates, not by image number. Blend overlays compatible series with adjustable opacity. Neither view corrects patient motion.'),
  make('h3','Open on a phone'),make('p','Start the server in LAN mode on the computer, then open its pairing link on the phone while connected to the same trusted Wi-Fi. A localhost link on a phone points to the phone itself.'),
  make('p','Files are processed by this self-hosted server. Use the original DICOM and a clinical viewer for diagnostic decisions.')]);

function facts(values) {const dl=make('dl'); for(const [k,v] of Object.entries(values||{})) if(v!==null && v!==undefined && String(v).trim()) dl.append(make('dt',k),make('dd',String(v))); return dl;}
$('#exam-info').onclick=()=>{
  const index=state.positions.get(state.series.id)||0;
  const frame=state.series.frames[index];const more=make('details');const data=make('div');let loading=false;
  more.append(make('summary',`DICOM tags · primary series, 2D slice ${index+1}`),data);
  more.ontoggle=async()=>{
    if(!more.open||loading||data.childElementCount)return;
    loading=true;data.textContent='Reading original DICOM tags…';
    try {const response=await json(`/api/tags/${encodeURIComponent(state.session)}/${encodeURIComponent(frame.id)}`,{signal:renderLife.signal});data.replaceChildren(facts(response.tags));}
    catch(e){data.textContent=e.name==='AbortError'?'View changed.':e.message;}finally{loading=false;}
  };
  dialog('Exam details',[
    make('h3',state.study.label||'Study'),facts({Patient:state.study.patient,Date:state.study.date,...state.study.details}),
    make('h3',state.series.label||'Series'),facts({Modality:state.series.modality,Images:state.series.frames.length,...state.series.details}),
    make('p',state.series.volume?'Spatial information is available for this volume.':state.series.volumeReason||'This series is available in 2D.'),more]);
};

function rail(open) {
  $('#shell').classList.toggle('show-rail',open); $('#mobile-library').setAttribute('aria-expanded',String(open));
  $('#mobile-library').textContent=open?'Hide exam browser':'Show exam browser';
}
$('#mobile-library').onclick=()=>{const open=!$('#shell').classList.contains('show-rail');rail(open);if(open)$('#rail').scrollIntoView({block:'start'});};
function status(msg,bad=false) {const p=$('#import-status'); p.textContent=msg; p.classList.toggle('error',bad);}

function exams() {
  const tree=$('#study-list'); tree.replaceChildren();
  for(const study of state.studies) {
    const group=make('details'); group.open=study.id===state.study?.id;
    const summary=make('summary',study.label||'Untitled exam');
    summary.append(make('small',[study.date,`${study.series.length} series`].filter(Boolean).join(' · '))); group.append(summary);
    for (const series of study.series) {
      const b=make('button',series.label||`${series.modality||'DICOM'} series`); b.type='button'; b.dataset.seriesId=series.id; b.setAttribute('aria-current',String(series===state.series));
      b.append(make('small',[series.modality,`${series.frames.length} images`,series.volume?'3D available':'2D'].filter(Boolean).join(' · ')));
      b.onclick=()=>{state.study=study; state.series=series; state.second=null; state.mode='slice'; rail(false); exams(); show();}; group.append(b);
    } tree.append(group);
  }
}
function adoptResult(result) {
  const studies=(result?.studies||[]).map(s=>({...s,series:(s.series||[]).filter(a=>a.frames?.length)})).filter(s=>s.series.length);
  if(!result?.session || !studies.length) throw new Error('No supported DICOM images were found. Choose the IMAGE folder or the original image files.');
  Object.assign(state,{session:result.session,studies,study:studies[0],series:studies[0].series[0],second:null,mode:'slice',positions:new Map(),annotationStore:new Map()});
  $('#shell').classList.add('loaded'); $('#welcome').hidden=true; $('#active').hidden=false; rail(false); exams();
  status(`${studies.length} exam${studies.length===1?'':'s'} open.${result.skipped?` Skipped ${result.skipped} non-image or unsupported file(s).`:''}`);
  show();
  return studies;
}
async function openSource(files) {
  if(files && !files.length) return;
  importLife?.abort(); const ctrl=new AbortController(); importLife=ctrl;
  $('#cancel-import').hidden=false;
  status(files?`Reading ${files.length} selected file${files.length===1?'':'s'}…`:'Reading the configured library…');
  try {
    const body=files?new FormData():undefined;
    if(files) for(const f of files) body.append('files',f,f.name);
    const result=await json(files?'/api/import':'/api/open-local',{method:'POST',body,signal:ctrl.signal});
    if(ctrl.signal.aborted) return;
    adoptResult(result);
  } catch(e) {if(!ctrl.signal.aborted) status(e.message,true);} finally {if(importLife===ctrl){$('#cancel-import').hidden=true;importLife=null;}}
}
$('#cancel-import').onclick=()=>{importLife?.abort(); status('Import cancelled.');};
for (const [b,i] of [['#open-files','#input-files'],['#open-folder','#input-folder']]) {
  $(b).onclick=()=>$(i).click(); $(i).onchange=e=>{const files=Array.from(e.target.files);e.target.value='';openSource(files);};
}

function readableDate(value) {
  const text=String(value??'').trim(); if(!text) return 'Date not recorded';
  let year, month, day;
  if(/^\d{8}$/.test(text)) {year=+text.slice(0,4);month=+text.slice(4,6);day=+text.slice(6,8);}
  else {const match=text.match(/^(\d{4})-(\d{2})-(\d{2})/); if(!match) return text; [year,month,day]=match.slice(1).map(Number);}
  const date=new Date(Date.UTC(year,month-1,day));
  if(Number.isNaN(date.getTime())||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day) return text;
  return new Intl.DateTimeFormat('en',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'}).format(date);
}
function modalityText(value) {
  const values=(Array.isArray(value)?value:[value]).map(v=>String(v??'').trim()).filter(Boolean);
  return [...new Set(values)].join(', ')||'Modality not recorded';
}
const plural=(n,singular,plural)=>`${n} ${n===1?singular:plural}`;
function setLibraryState(message,bad=false) {const p=$('#library-state');p.textContent=message||'';p.classList.toggle('error',bad);}
function libraryError(message) {
  const p=make('p',message);const retry=make('button','Try again','quiet');retry.type='button';
  retry.onclick=()=>beginLibraryLoad();
  const box=$('#library-state');box.classList.add('error');box.replaceChildren(p,retry);
  $('#library-list').setAttribute('aria-busy','false');
}
function refreshLibraryControls() {
  const busy=library.busy!==null;
  $('#library-add-files').disabled=busy; $('#library-add-folder').disabled=busy;
  for(const button of $('#library-list').querySelectorAll('button')) button.disabled=busy;
  $('#library-dialog').setAttribute('aria-busy',String(busy));
}
function renderLibrary(skipped=0) {
  const list=$('#library-list');list.replaceChildren();list.setAttribute('aria-busy','false');
  if(!library.studies.length) {
    setLibraryState(`No saved exams were found.${skipped?` Skipped ${skipped} unsupported file(s).`:''}`);
    refreshLibraryControls();return;
  }
  for(const study of library.studies) {
    const button=make('button',undefined,'library-study');button.type='button';button.dataset.studyId=String(study.id??'');
    const date=readableDate(study.date), modalities=modalityText(study.modalities);
    const seriesCount=Number.isFinite(Number(study.seriesCount))?Number(study.seriesCount):0;
    const frameCount=Number.isFinite(Number(study.frameCount))?Number(study.frameCount):0;
    button.append(make('strong',study.label||'Untitled exam'),
      make('span',`${date} · ${modalities}`),
      make('span',`${plural(seriesCount,'series','series')} · ${plural(frameCount,'image','images')}`));
    button.onclick=()=>openLibraryStudy(study);
    const item=make('li');item.append(button);list.append(item);
  }
  setLibraryState(skipped?`Skipped ${skipped} unsupported file(s).`:'');
  refreshLibraryControls();
}
function abortLibraryRequests() {
  for(const key of ['listLife','openLife','uploadLife']) {library[key]?.abort();library[key]=null;}
}
async function loadLibraryStudies(generation,initial) {
  const ctrl=new AbortController();library.listLife=ctrl;
  try {
    const result=await json('/api/library/studies',{signal:ctrl.signal});
    if(generation!==library.generation) return;
    library.studies=Array.isArray(result.studies)?result.studies:[];
    renderLibrary(Number(result.skipped)||0);
  } catch(e) {
    if(e.name==='AbortError'||generation!==library.generation) return;
    if(!initial&&library.studies.length) {setLibraryState(`Could not refresh the saved exams. ${e.message}`,true);$('#library-list').setAttribute('aria-busy','false');}
    else libraryError(`Could not load saved exams. ${e.message}`);
  } finally {if(library.listLife===ctrl)library.listLife=null;}
}
function beginLibraryLoad() {
  const generation=++library.generation;abortLibraryRequests();library.busy=null;refreshLibraryControls();
  const list=$('#library-list');list.replaceChildren();list.setAttribute('aria-busy','true');
  setLibraryState('Loading saved exams…');
  loadLibraryStudies(generation,true);
}
function openLibrary() {
  const dlg=$('#library-dialog');if(!dlg.open) dlg.showModal();
  const writeStatus=$('#library-write-status');writeStatus.textContent='';writeStatus.classList.remove('error');
  beginLibraryLoad();
}
async function openLibraryStudy(study) {
  if(library.busy) return;
  const generation=++library.generation;abortLibraryRequests();
  const ctrl=new AbortController();library.openLife=ctrl;library.busy='open';refreshLibraryControls();
  $('#library-list').setAttribute('aria-busy','true');
  setLibraryState(`Opening ${study.label||'selected exam'}…`);
  try {
    const result=await json(`/api/library/studies/${encodeURIComponent(study.id)}/open`,{method:'POST',signal:ctrl.signal});
    if(generation!==library.generation) return;
    importLife?.abort();
    adoptResult(result);
    if($('#library-dialog').open) $('#library-dialog').close();
  } catch(e) {
    if(e.name==='AbortError'||generation!==library.generation) return;
    $('#library-list').setAttribute('aria-busy','false');
    setLibraryState(`Could not open that exam. ${e.message}`,true);
  } finally {if(generation===library.generation){library.busy=null;refreshLibraryControls();}}
}
function setWriteStatus(message,bad=false) {const p=$('#library-write-status');p.textContent=message; p.classList.toggle('error',bad);}
async function uploadLibrary(files) {
  if(!files?.length||library.busy) return;
  const generation=++library.generation;abortLibraryRequests();
  const ctrl=new AbortController();library.uploadLife=ctrl;library.busy='upload';refreshLibraryControls();
  $('#library-list').setAttribute('aria-busy','true');
  setWriteStatus(`Adding ${plural(files.length,'file','files')}…`);
  try {
    const body=new FormData();for(const file of files) body.append('files',file,file.name);
    const result=await json('/api/library/uploads',{method:'POST',body,signal:ctrl.signal});
    if(generation!==library.generation) return;
    const added=Number(result?.added)||0, skipped=Number(result?.skipped)||0;
    setWriteStatus(`${added?`${plural(added,'file','files')} added.`:'No new files were added.'}${skipped?` Skipped ${plural(skipped,'file','files')}.`:''}`);
    await loadLibraryStudies(generation,false);
  } catch(e) {
    if(e.name==='AbortError'||generation!==library.generation) return;
    $('#library-list').setAttribute('aria-busy','false');
    setWriteStatus(`Could not add the selected files. ${e.message}`,true);
  } finally {if(generation===library.generation){library.busy=null;library.uploadLife=null;refreshLibraryControls();}}
}
$('#open-library').onclick=openLibrary;
$('#close-library').onclick=()=>$('#library-dialog').close();
$('#library-dialog').addEventListener('close',()=>{
  library.generation++;abortLibraryRequests();library.busy=null;refreshLibraryControls();
});
$('#library-add-files').onclick=()=>$('#library-input-files').click();
$('#library-add-folder').onclick=()=>$('#library-input-folder').click();
for (const input of ['#library-input-files','#library-input-folder']) {
  $(input).onchange=e=>{const files=Array.from(e.target.files);e.target.value='';uploadLibrary(files);};
}
json('/api/config').then(config=>{
  const configured=config?.library===true;
  library.writable=configured&&config.libraryWritable===true;
  $('#open-library').hidden=!configured;$('#library-write').hidden=!library.writable;
}).catch(e=>status(e.message,true));

function source(session, signal) {
  // This cache is local to the active view and bounded; a CT volume must not retain 173 full frames here.
  const cache=new Map(); let bytes=0;
  const combined=s=>s && s!==signal ? AbortSignal.any([signal,s]):signal;
  return {
    signal,annotationStore:state.annotationStore,
    async loadFrame(id,s){const sig=combined(s); sig.throwIfAborted(); if(cache.has(id)) return cache.get(id);
      const frame=await getFrame(session,id,sig); sig.throwIfAborted();
      if(frame.pixels.byteLength<=6*1024*1024&&!cache.has(id)){
        while(cache.size && bytes+frame.pixels.byteLength>6*1024*1024){const key=cache.keys().next().value;bytes-=cache.get(key).pixels.byteLength;cache.delete(key);}
        cache.set(id,frame);bytes+=frame.pixels.byteLength;
      }return frame;},
    async loadTags(id,s){return (await json(`/api/tags/${encodeURIComponent(session)}/${encodeURIComponent(id)}`,{signal:combined(s)})).tags;},
    async loadOverlays(id,s){return (await json(`/api/overlays/${encodeURIComponent(session)}/${encodeURIComponent(id)}`,{signal:combined(s)})).overlays;}
  };
}

const blendable=(a,b)=>a!==b && a.modality==='CT' && b.modality==='CT' && !!matchStacks(a,b);
function volumeUnavailableReason(series) {
  const reason=String(series?.volumeReason??'').trim().replace(/[.!?]+$/,'');
  return reason||'this series does not have a regular 3D stack';
}
function compareOptions() {
  const options=state.studies.flatMap(st=>st.series.filter(s=>s!==state.series).map(s=>({st,s})));
  const choices=state.mode==='blend'?options.filter(({s})=>blendable(state.series,s)):options;
  if(!choices.some(({s})=>s===state.second)) state.second=choices.find(({s})=>matchStacks(state.series,s))?.s || choices.find(({st})=>st===state.study)?.s || choices[0]?.s;
  const select=$('#compare-series'); select.replaceChildren();
  choices.forEach(({st,s},i)=>{const opt=make('option',`${st.date||'Study'} · ${s.label||s.modality} (${s.frames.length})`);opt.value=String(i);opt.selected=s===state.second;select.append(opt);});
  select.onchange=()=>{state.second=choices[select.selectedIndex].s;show();};
  return options.length>0;
}

function mount(host,series,mode,io,initialIndex=0) {
  const {signal}=io;
  host.dataset.view=mode;host.dataset.state='loading';
  if(mode==='slice') host.addEventListener('slice-position',e=>{const i=e.detail?.index;if(Number.isInteger(i)&&i>=0&&i<series.frames.length)state.positions.set(series.id,i);},{signal});
  host.replaceChildren(make('p','Opening view…','muted'));
  return (async()=>{
    try {
      const lib=mode==='volume'?await import('./volume.js'):mode==='blend'?await import('./blend.js'):await import('./slice.js');
      if(signal.aborted)return;
      host.replaceChildren();
      const cleanup=await (mode==='volume'?lib.mountVolume:mode==='blend'?lib.mountBlend:lib.mountSlice)(host,{...io,series,second:state.second,initialIndex});
      if(typeof cleanup==='function') {if(signal.aborted)cleanup();else signal.addEventListener('abort',cleanup,{once:true});}
      if(!signal.aborted)host.dataset.state='mounted';
    } catch(e) {if(!signal.aborted){host.dataset.state='error';host.replaceChildren(make('p',e.message||'Unable to display this image.','view-error'));}}
  })();
}

function show() {
  if(state.mode==='volume'&&!state.series.volume) state.mode='slice';
  renderLife?.abort(); const ctrl=new AbortController();renderLife=ctrl;
  const io=source(state.session,ctrl.signal); const area=$('#view-area');area.replaceChildren();
  $('#active-name').textContent=state.series.label||state.study.label||'Untitled series';
  $('#active-summary').textContent=[state.study.date,state.series.modality,`${state.series.frames.length} images`].filter(Boolean).join(' / ');
  const canCompare=compareOptions();
  const canBlend=state.studies.some(st=>st.series.some(s=>blendable(state.series,s)));
  const volumeButton=document.querySelector('[data-mode="volume"]');
  const sliceButton=document.querySelector('[data-mode="slice"]');
  const reason=$('#volume-reason');
  const reasonText=state.series.volume?'':`Explore in 3D is unavailable: ${volumeUnavailableReason(state.series)}.`;
  reason.textContent=reasonText; reason.hidden=!reasonText;
  for(const button of [volumeButton,sliceButton]) {
    if(reasonText) button.setAttribute('aria-describedby',reason.id); else button.removeAttribute('aria-describedby');
  }
  for(const button of document.querySelectorAll('[data-mode]')) {
    const mode=button.dataset.mode;
    button.disabled=mode==='volume'&&!state.series.volume || mode==='compare'&&!canCompare || mode==='blend'&&!canBlend;
    if(mode==='volume') button.removeAttribute('title');
    else button.title=button.disabled ? (mode==='blend'?'Requires two parallel stacks in the same spatial reference.':'Open at least two series to compare.') : '';
    button.setAttribute('aria-pressed',String(mode===state.mode));
  }
  $('#compare-config').hidden=!['compare','blend'].includes(state.mode);
  $('#link-slices').closest('label').hidden=state.mode!=='compare'; $('#link-note').hidden=state.mode!=='compare';
  if(state.mode!=='compare') {
    const host=make('div',undefined,'view-host'); area.append(host); mount(host,state.series,state.mode,io,state.positions.get(state.series.id)||0); return;
  }
  const panels=make('div',undefined,'comparison');area.append(panels);
  const series=[state.series,state.second], links=[matchStacks(...series),matchStacks(series[1],series[0])];
  const check=$('#link-slices');check.disabled=!links.every(Boolean);check.checked=!check.disabled;
  $('#link-note').textContent=check.disabled?'Independent views: no matching spatial reference.':'Matches recorded slice positions; no motion correction.';
  const hosts=series.map(s=>{const pane=make('section',undefined,'compare-pane');const host=make('div',undefined,'view-host');pane.append(make('h3',s.label||'Series'),host);panels.append(pane);return host;});
  const first=state.positions.get(series[0].id)||0;
  const indices=[first,links[0]?.(first)??(state.positions.get(series[1].id)||0)];
  const sync=i=>{
    if(check.disabled)return;
    const j=links[i]?.(indices[i]);
    $('#link-note').textContent=!check.checked?'Independent scrolling.':Number.isInteger(j)?'Matches recorded slice positions; no motion correction.':'Outside the other stack. No matching slice.';
    if(check.checked&&Number.isInteger(j)&&j!==indices[1-i]){indices[1-i]=j;state.positions.set(series[1-i].id,j);hosts[1-i].dispatchEvent(new CustomEvent('slice-jump',{detail:{index:j}}));}
  };
  check.onchange=()=>sync(0);
  hosts.forEach((host,i)=>{
    host.addEventListener('slice-position',e=>{indices[i]=e.detail.index;sync(i);},{signal:ctrl.signal});
    mount(host,series[i],'slice',io,indices[i]);
  });
}
for (const b of document.querySelectorAll('[data-mode]')) b.onclick=()=>{
  const mode=b.dataset.mode;
  if(b.disabled||mode==='volume'&&!state.series.volume) return;
  if(state.mode!==mode){state.mode=mode;show();}
};
