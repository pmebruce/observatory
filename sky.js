'use strict';

const R = Math.PI / 180;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const wrap = n => (n % 360 + 360) % 360;
const relativeAngle = n => wrap(n + 180) - 180;
const signedDegrees = n => (n > 0 ? '+' : '') + n + '°';
const directionName = az => ['北','東北','東','東南','南','西南','西','西北'][Math.round(wrap(az)/45)%8];

function equatorialVector(ra, dec) {
  return [Math.cos(dec*R)*Math.cos(ra*R), Math.cos(dec*R)*Math.sin(ra*R), Math.sin(dec*R)];
}

function skyTransform(date, lat, lon) {
  const days = date.getTime()/86400000 + 2440587.5 - 2451545;
  const t = days / 36525;
  const sidereal = wrap(280.46061837 + 360.98564736629*days + 0.000387933*t*t + lon)*R;
  const sinL = Math.sin(lat*R), cosL = Math.cos(lat*R);
  const sinS = Math.sin(sidereal), cosS = Math.cos(sidereal);

  // Precess the J2000 catalog to the observation date before rotating to the local sky.
  const zeta = (2306.2181*t + 0.30188*t*t + 0.017998*t*t*t)*R/3600;
  const z = (2306.2181*t + 1.09468*t*t + 0.018203*t*t*t)*R/3600;
  const theta = (2004.3109*t - 0.42665*t*t - 0.041833*t*t*t)*R/3600;
  const p = Math.cos(zeta), q = Math.sin(zeta);
  const u = Math.cos(z), v = Math.sin(z);
  const k = Math.cos(theta), l = Math.sin(theta);

  return ([x,y,n]) => {
    const a = p*x - q*y;
    const b = q*x + p*y;
    const c = k*a - l*n;
    const dec = l*a + k*n;
    const raX = u*c - v*b;
    const raY = v*c + u*b;
    const meridian = cosS*raX + sinS*raY;
    return [cosS*raY - sinS*raX, cosL*dec - sinL*meridian, sinL*dec + cosL*meridian];
  };
}

function directionOf([east,north,up]) {
  return {az:wrap(Math.atan2(east,north)/R), alt:Math.asin(clamp(up,-1,1))/R};
}

function localVector(az, alt) {
  return [Math.sin(az*R)*Math.cos(alt*R), Math.cos(az*R)*Math.cos(alt*R), Math.sin(alt*R)];
}

function cameraOrientation(event, calibration) {
  if (![event.alpha,event.beta,event.gamma].every(Number.isFinite)) return null;
  const beta = event.beta*R, gamma = event.gamma*R;
  const screenUp = Math.cos(beta)*Math.cos(gamma);
  const alt = Math.asin(clamp(-screenUp,-1,1))/R;
  let northOffset = 0;
  if (!event.absolute) {
    const heading = event.webkitCompassHeading;
    const accuracy = event.webkitCompassAccuracy;
    const hasCompass = Number.isFinite(heading) && heading>=0
      && (!Number.isFinite(accuracy) || accuracy>=0);
    if (calibration.northOffset===null && hasCompass && screenUp>.94) {
      // While screen-up, the compass measures the top edge. Match it to
      // the same edge in the relative device orientation reference frame.
      calibration.northOffset=relativeAngle(heading+event.alpha);
    }
    if (calibration.northOffset===null) return hasCompass ? {needsLevel:true} : null;
    northOffset=calibration.northOffset;
  }
  const alpha = event.alpha*R;
  const east = -Math.cos(alpha)*Math.sin(gamma)-Math.sin(alpha)*Math.sin(beta)*Math.cos(gamma);
  const north = -Math.sin(alpha)*Math.sin(gamma)+Math.cos(alpha)*Math.sin(beta)*Math.cos(gamma);
  return {az:wrap(Math.atan2(east,north)/R+northOffset),alt};
}

const $ = id => document.getElementById(id);
const canvas = $('map');
const toolsDialog = $('sky-tools');
const ctx = canvas.getContext('2d');
const catalog = window.skyCatalog;
const stars = catalog.stars.map(([ra,dec,mag,bv,name,en,id]) => ({
  vector:equatorialVector(ra,dec), mag, bv, name, en, id, kind:'star'
}));
const constellations = catalog.constellations.map(([id,name,en,ra,dec,lines]) => ({
  id, name, en, kind:'constellation', vector:equatorialVector(ra,dec),
  lines:lines.map(segment => segment.map(point => equatorialVector(...point)))
}));
const namedStars = stars.filter(star => star.name).sort((a,b) => a.mag-b.mag);
const aliases = {Ari:'白羊座 牧羊座',Aqr:'水瓶座',Sgr:'射手座',UMa:'北斗七星 北斗 大熊',UMi:'小北斗',Ori:'獵戶 Orion 參宿',Tau:'昴宿 昴宿星團',Lyr:'織女',Aql:'牽牛 牛郎'};
const searchable = [...constellations, ...namedStars];

const state = {
  lat:24.82, lon:121.01, az:180, alt:42, fov:66, lines:true, tracking:false,
  waiting:false, offset:0, pointed:null, selected:null, dirty:true, width:0, height:0,
  ratio:1, hits:[], lastSky:0, lastFrame:0
};
const calibration = {northOffset:null};
const points = Array.from({length:91}, (_,i) => localVector(i*4,0));
const horizon = [points, ...[-30,30,60].map(alt => Array.from({length:91}, (_,i)=>localVector(i*4,alt)))];
const cardinal = [0,90,180,270].map(az => ({name:directionName(az), local:localVector(az,0)}));
const displayTime = new Intl.DateTimeFormat('zh-TW',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

function refreshSky() {
  const now = new Date();
  const toLocal = skyTransform(now,state.lat,state.lon);
  for (const star of stars) star.local = toLocal(star.vector);
  for (const group of constellations) {
    group.local = toLocal(group.vector);
    group.localLines = group.lines.map(segment => segment.map(toLocal));
  }
  state.lastSky = now.getTime();
  $('clock').textContent = displayTime.format(now);
  updateResults();
  updateSelection();
  state.dirty = true;
}

function measure() {
  const bounds = canvas.getBoundingClientRect();
  state.width = bounds.width;
  state.height = bounds.height;
  state.ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(state.width*state.ratio);
  canvas.height = Math.round(state.height*state.ratio);
  state.dirty = true;
}

function projection() {
  const [forwardX,forwardY,forwardZ] = localVector(state.az,state.alt);
  const east = Math.cos(state.az*R), north = -Math.sin(state.az*R);
  const upX = -Math.sin(state.az*R)*Math.sin(state.alt*R);
  const upY = -Math.cos(state.az*R)*Math.sin(state.alt*R);
  const upZ = Math.cos(state.alt*R);
  const scale = Math.min(state.width,state.height)/2/Math.tan(state.fov*R/2);
  return ([x,y,z]) => {
    const depth = x*forwardX+y*forwardY+z*forwardZ;
    if (depth < 0.045) return null;
    return [state.width/2+scale*(x*east+y*north)/depth,state.height/2-scale*(x*upX+y*upY+z*upZ)/depth];
  };
}

function isVisible(point,padding=0) {
  return point && point[0]>=-padding && point[0]<=state.width+padding
    && point[1]>=-padding && point[1]<=state.height+padding;
}

function draw() {
  const {width,height,ratio} = state;
  const margin = $('quiet').getAttribute('aria-pressed')==='true' ? 12 : 50;
  if (!width || !height) return;
  const project = projection();
  ctx.setTransform(ratio,0,0,ratio,0,0);
  const backdrop = ctx.createLinearGradient(0,0,width*.3,height);
  backdrop.addColorStop(0,'#080c1d');
  backdrop.addColorStop(.55,'#111c37');
  backdrop.addColorStop(1,'#13233c');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0,0,width,height);

  function drawPath(path) {
    let previous = null;
    for (const vector of path) {
      const current = project(vector);
      if (previous && current) {
        ctx.moveTo(...previous);
        ctx.lineTo(...current);
      }
      previous = current;
    }
  }

  horizon.forEach((path,i) => {
    ctx.beginPath();
    drawPath(path);
    ctx.setLineDash(i === 0 ? [5,6] : [2,7]);
    ctx.lineWidth = i===0 ? 1.25 : .8;
    ctx.strokeStyle = i===0 ? '#86b8d988' : '#83b1dd21';
    ctx.stroke();
  });
  ctx.setLineDash([]);
  for (const group of constellations) {
    if (!state.lines && state.selected !== group) continue;
    const active = state.selected === group;
    ctx.beginPath();
    for (const segment of group.localLines) drawPath(segment);
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeStyle = active ? '#ffdb99da' : '#85b7ec76';
    ctx.stroke();
  }

  for (const star of stars) {
    const point = project(star.local);
    if (!isVisible(point,8)) continue;
    const [x,y] = point;
    const above = star.local[2]>=0;
    if (!above && star.mag>3.3) continue;
    const radius = clamp(2.65-star.mag*.33,.55,3.1);
    const opacity = above ? clamp(1-star.mag*.12,.23,1) : .26;
    if (star.mag<1.3 && above) {
      const glow = ctx.createRadialGradient(x,y,0,x,y,radius*5);
      glow.addColorStop(0,star.bv>1.1?'#ffdba170':'#b9dbff91');
      glow.addColorStop(1,'#9cc6ff00');
      ctx.fillStyle=glow;
      ctx.beginPath();
      ctx.arc(x,y,radius*5,0,Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha=opacity;
    ctx.fillStyle=star.bv>1.1?'#ffe0b4':star.bv<.2?'#d2e6ff':'#f5f4ee';
    ctx.beginPath();
    ctx.arc(x,y,radius,0,Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha=1;

  const labels=[];
  state.hits=[];
  function label(item, point, color, size, dy=0) {
    if (!isVisible(point)) return;
    const [x,py] = point;
    const y=py+dy;
    ctx.font='600 '+size+'px system-ui, sans-serif';
    const w=ctx.measureText(item.name).width;
    const box=[x-w/2-5,y-size/2-3,x+w/2+5,y+size/2+3];
    if (box[0]<4 || box[2]>width-4 || box[1]<margin || box[3]>height-margin) return;
    if (labels.some(a=>box[0]<a[2] && box[2]>a[0] && box[1]<a[3] && box[3]>a[1])) return;
    labels.push(box);
    ctx.textAlign='center';
    ctx.textBaseline='middle';
    ctx.lineWidth=4;
    ctx.lineJoin='round';
    ctx.strokeStyle='#0a1225ed';
    ctx.strokeText(item.name,x,y);
    ctx.fillStyle=color;
    ctx.fillText(item.name,x,y);
    if (item.kind) state.hits.push({item,box,point});
  }

  if (state.selected) {
    const target = project(state.selected.local);
    if (isVisible(target)) {
      ctx.beginPath();
      ctx.arc(target[0],target[1],11,0,2*Math.PI);
      ctx.strokeStyle='#ffdb99';
      ctx.lineWidth=1.4;
      ctx.stroke();
      label(state.selected,target,'#ffdb99',15,-23);
    }
  }
  for (const item of cardinal) label(item,project(item.local),'#b7ebff',14,13);
  for (const item of constellations) {
    if (item !== state.selected) label(item,project(item.local),item.local[2]>=0?'#a6cfff':'#91a2bc',15);
  }
  for (const item of namedStars) {
    if (item === state.selected || item.local[2]<0 || (item.mag>1.9 && state.fov>50)) continue;
    const p = project(item.local);
    if (!isVisible(p)) continue;
    label(item,p,'#f3e4c9',13,-12);
    state.hits.push({item,point:p});
  }

  $('direction').textContent=directionName(state.az);
  $('bearing').textContent=wrap(Math.round(state.az))+'°';
  $('elevation').textContent=(state.alt<0?'俯角 ':'仰角 ')+Math.round(Math.abs(state.alt))+'°';
  for (const button of document.querySelectorAll('[data-az]')) {
    button.setAttribute('aria-current',String(Math.abs(relativeAngle(state.az-Number(button.dataset.az)))<=22.5));
  }
}

function setView(az,alt) {
  state.az=wrap(az);
  state.alt=clamp(alt,-89.9,89.9);
  state.dirty=true;
}

function changeZoom(delta) {
  state.fov=clamp(state.fov+delta,22,95);
  $('zoom-in').disabled=state.fov===22;
  $('zoom-out').disabled=state.fov===95;
  state.dirty=true;
}

function describe(item) {
  const {az,alt}=directionOf(item.local);
  return alt<0?'地平線下 '+Math.round(-alt)+'°':directionName(az)+'方 · '+Math.round(alt)+'°';
}

function updateResults() {
  const query=$('query').value.trim().toLowerCase();
  const items=query
    ? searchable.filter(item=>[item.name,item.en,item.id,item.kind==='constellation'?aliases[item.id]:''].filter(Boolean).some(value=>value.toLowerCase().includes(query))).slice(0,26)
    : namedStars.filter(star=>star.local[2]>Math.sin(8*R)).slice(0,5);
  $('result-label').textContent=query?(items.length?'搜尋結果':'沒有符合的星座或亮星'):'地平線上的亮星';
  const fragment=document.createDocumentFragment();
  for (const item of items) {
    const li=document.createElement('li');
    const button=document.createElement('button');
    const name=document.createElement('strong');
    const detail=document.createElement('small');
    button.type='button';
    name.textContent=item.name;
    detail.textContent=describe(item);
    button.append(name,detail);
    button.addEventListener('click',()=>select(item,true));
    li.append(button);
    fragment.append(li);
  }
  $('results').replaceChildren(fragment);
}

function updateSelection() {
  const item=state.selected;
  $('selected').hidden=!item;
  if (!item) return;
  $('selected-name').textContent=item.name;
  const details=[item.en===item.name?'':item.en,describe(item)];
  if (item.kind==='star') details.push('星等 '+item.mag.toFixed(1));
  $('selected-detail').textContent=details.filter(Boolean).join(' · ');
}

function centerSelection() {
  if (!state.selected) return;
  stopTracking();
  const {az,alt}=directionOf(state.selected.local);
  setView(az,alt);
  if (toolsDialog.open) toolsDialog.close();
}

function select(item,center=false) {
  state.selected=item;
  updateSelection();
  if (center) centerSelection();
  state.dirty=true;
}

let sensorTimeout;
let statusTimeout;
function showStatus(message='', persistent=false) {
  const mapStatus = $('status');
  const dialogStatus = $('panel-status');
  if (mapStatus.textContent===message && dialogStatus.textContent===message) return;
  clearTimeout(statusTimeout);
  mapStatus.textContent=message;
  dialogStatus.textContent=message;
  if (message && !persistent) statusTimeout=setTimeout(showStatus,5500);
}
function displayTracking(active) {
  $('sensor').setAttribute('aria-pressed',String(active));
  $('sensor').lastElementChild.textContent=active?'停止指向':'手機指向';
  $('sensor').setAttribute('aria-label',active?'停止手機指向':'啟用手機指向');
  $('correction').hidden=!active;
}

function stopTracking(message='') {
  if (!state.tracking && !state.waiting && !message) return;
  state.tracking=false;
  state.waiting=false;
  state.pointed=null;
  calibration.northOffset=null;
  clearTimeout(sensorTimeout);
  window.removeEventListener('deviceorientation',readSensor);
  window.removeEventListener('deviceorientationabsolute',readSensor);
  displayTracking(false);
  showStatus(message);
}

function readSensor(event) {
  const point=cameraOrientation(event,calibration);
  if (!point) return;
  if (point.needsLevel) {
    showStatus('請先將手機螢幕朝上放平，校準羅盤後再舉向天空。',true);
    return;
  }
  if (state.waiting) {
    state.waiting=false;
    state.tracking=true;
    clearTimeout(sensorTimeout);
    displayTracking(true);
    showStatus('舉起手機，讓背面朝向天空。');
    if (point.alt>-70) setView(point.az+state.offset,point.alt);
  }
  state.pointed=point;

}

async function toggleTracking() {
  if (state.tracking || state.waiting) {
    stopTracking();
    return;
  }
  if (!window.isSecureContext || !window.DeviceOrientationEvent) {
    showStatus('請用 Safari 開啟網址以啟用指向。你也可以拖曳星圖。');
    return;
  }
  state.waiting=true;
  showStatus('正在取得手機方向…',true);
  try {
    if (typeof DeviceOrientationEvent.requestPermission==='function') {
      const permission = await DeviceOrientationEvent.requestPermission(true);
      if (!state.waiting) return;
      if (permission!=='granted') {
        stopTracking('方向感測未獲授權。請用 Safari 開啟此頁並允許動作與方向存取。');
        return;
      }
    }
  } catch {
    if (state.waiting) stopTracking('無法取得方向感測權限。請在 Safari 直接開啟此頁，或拖曳星圖。');
    return;
  }
  window.addEventListener('deviceorientation',readSensor);
  window.addEventListener('deviceorientationabsolute',readSensor);
  sensorTimeout=setTimeout(()=>{
    if (state.waiting) stopTracking('沒有收到羅盤方向。請用 Safari 開啟，啟用後先將手機螢幕朝上放平。');
  },12000);
}

function locate() {
  if (!navigator.geolocation) {
    showStatus('此瀏覽器無法定位，目前使用竹北位置。');
    return;
  }
  const button=$('locate');
  button.disabled=true;
  $('place').textContent='定位中';
  navigator.geolocation.getCurrentPosition(position=>{
    state.lat=position.coords.latitude;
    state.lon=position.coords.longitude;
    $('place').textContent='目前位置';
    button.title=state.lat.toFixed(3)+'°, '+state.lon.toFixed(3)+'°';
    button.disabled=false;
    refreshSky();
  },()=>{
    button.disabled=false;
    $('place').textContent=state.lat===24.82 && state.lon===121.01?'竹北預設位置':'上次定位';
    showStatus('這次無法取得位置，繼續使用畫面上顯示的位置。');
  },{timeout:8000,maximumAge:120000});
}

let drag=null;
canvas.addEventListener('pointerdown',e=>{
  if (drag || e.button!==0) return;
  canvas.setPointerCapture(e.pointerId);
  drag={id:e.pointerId,x:e.clientX,y:e.clientY,az:state.az,alt:state.alt,moved:false};
});
canvas.addEventListener('pointermove',e=>{
  if (!drag || drag.id!==e.pointerId) return;
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if (Math.hypot(dx,dy)>5) drag.moved=true;
  if (!drag.moved) return;
  stopTracking();
  const degrees=state.fov/Math.min(state.width,state.height);
  setView(drag.az-dx*degrees,drag.alt+dy*degrees);
});
canvas.addEventListener('pointerup',e=>{
  if (drag?.id!==e.pointerId) return;
  if (!drag.moved) {
    const rect=canvas.getBoundingClientRect();
    const x=e.clientX-rect.left,y=e.clientY-rect.top;
    const hit=state.hits.find(({box})=>box && x>=box[0] && x<=box[2] && y>=box[1] && y<=box[3])
      || state.hits.filter(({point})=>Math.hypot(point[0]-x,point[1]-y)<15)
        .sort((a,b)=>Math.hypot(a.point[0]-x,a.point[1]-y)-Math.hypot(b.point[0]-x,b.point[1]-y))[0];
    if (hit) select(hit.item);
  }
  drag=null;
});
canvas.addEventListener('pointercancel',()=>{drag=null;});
canvas.addEventListener('lostpointercapture',()=>{drag=null;});
canvas.addEventListener('wheel',e=>{e.preventDefault();changeZoom(e.deltaY>0?6:-6);},{passive:false});

$('sensor').addEventListener('click',toggleTracking);
$('tools').addEventListener('click',()=>toolsDialog.showModal());
$('quiet').addEventListener('click',event=>{
  const button=event.currentTarget;
  const quiet=$('sky-view').classList.toggle('quiet');
  button.setAttribute('aria-pressed',String(quiet));
  button.textContent=quiet?'顯示工具':'純星空';
  state.dirty=true;
});
$('locate').addEventListener('click',locate);
$('query').addEventListener('input',updateResults);
$('clear').addEventListener('click',()=>select(null));
$('center').addEventListener('click',centerSelection);
$('zoom-in').addEventListener('click',()=>changeZoom(-10));
$('zoom-out').addEventListener('click',()=>changeZoom(10));
$('lines').addEventListener('click',()=>{
  state.lines=!state.lines;
  $('lines').setAttribute('aria-pressed',String(state.lines));
  state.dirty=true;
});
for (const button of document.querySelectorAll('[data-az]')) {
  button.addEventListener('click',()=>{
    stopTracking();
    setView(Number(button.dataset.az),32);
  });
}
for (const [id,step] of [['offset-down',-5],['offset-up',5]]) {
  $(id).addEventListener('click',()=>{
    state.offset=relativeAngle(state.offset+step);
    $('offset').textContent=signedDegrees(state.offset);
  });
}

new ResizeObserver(measure).observe(canvas);
measure();
refreshSky();
function frame(timestamp) {
  requestAnimationFrame(frame);
  if (Date.now()-state.lastSky>15000) refreshSky();
  if (timestamp-state.lastFrame<26) return;
  state.lastFrame=timestamp;
  if (state.tracking && state.pointed && state.pointed.alt>-82) {
    const azDelta=relativeAngle(state.pointed.az+state.offset-state.az);
    const altDelta=state.pointed.alt-state.alt;
    // Heading has no stable value when the optical axis points directly overhead.
    const smoothAz = Math.abs(state.pointed.alt)>87 ? 0 : azDelta*.27;
    if (Math.abs(smoothAz)>.06 || Math.abs(altDelta)>.15) {
      setView(state.az+smoothAz,state.alt+altDelta*.27);
    }
  }
  if (state.dirty) {
    state.dirty=false;
    draw();
  }
}
requestAnimationFrame(frame);
