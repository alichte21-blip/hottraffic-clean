(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    role: localStorage.getItem('ht_role') || 'passenger', map: null, userPos: null, userMarker: null,
    liveLayers: [], hotspotId: localStorage.getItem('ht_hotspot_id') || '',
    driverId: localStorage.getItem('ht_driver_id') || ((globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('driver-'+Date.now()+'-'+Math.random().toString(36).slice(2))),
    driverLive: false, heartbeat: null, refreshTimer: null, driverToken: sessionStorage.getItem('ht_driver_token') || ''
  };
  localStorage.setItem('ht_driver_id', state.driverId);

  function setText(id, text){ const el=$(id); if(el) el.textContent=text; }
  function escapeHtml(s=''){ return String(s).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  async function api(path, options={}){
    const driverHeader=(path.startsWith('/api/vehicles')||path.startsWith('/api/driver/')) && state.driverToken ? {'x-driver-token':state.driverToken} : {};
    const res = await fetch(path,{cache:'no-store',headers:{'content-type':'application/json',...driverHeader,...(options.headers||{})},...options});
    let data={}; try{ data=await res.json(); }catch{}
    if(!res.ok) throw new Error(data.message||data.error||`HTTP ${res.status}`);
    return data;
  }

  function taxiIcon(){ return L.divIcon({className:'taxi-marker',iconSize:[44,28],iconAnchor:[22,14],html:'<div class="taxi-pin"><i class="roof"></i><i class="body"></i><i class="wheel w1"></i><i class="wheel w2"></i></div>'}); }
  function passengerIcon(){ return L.divIcon({className:'passenger-marker',iconSize:[46,58],iconAnchor:[23,51],html:'<div class="passenger-pin"><i class="halo"></i><i class="person"></i><i class="bag"></i></div>'}); }
  function userIcon(){ return L.divIcon({className:'user-marker',iconSize:[18,18],iconAnchor:[9,9],html:'<div class="user-dot"></div>'}); }

  function initMap(){
    state.map=L.map('map',{zoomControl:true,attributionControl:true}).setView([52.5200,13.4050],12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_3k27_1_9605aea3358c7050136f2461',{maxZoom:20,attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(state.map);
  }
  function clearLive(){ state.liveLayers.forEach(x=>state.map.removeLayer(x)); state.liveLayers=[]; }
  function validCoord(v){ const n=Number(v); return Number.isFinite(n); }
  function drawState(data){
    clearLive(); const hs=Array.isArray(data.hotspots)?data.hotspots:[], vs=Array.isArray(data.vehicles)?data.vehicles:[];
    const liveCoords=[];
    setText('driverCount',vs.length); setText('demandCount',hs.length);
    vs.forEach(v=>{
      if(!validCoord(v.lat)||!validCoord(v.lng)) return;
      const pos=[Number(v.lat),Number(v.lng)];
      const m=L.marker(pos,{icon:taxiIcon(),zIndexOffset:700,keyboard:false})
        .addTo(state.map).bindPopup('<b>Taxi LIVE</b><br>Zuletzt aktualisiert');
      state.liveLayers.push(m); liveCoords.push(pos);
    });
    hs.forEach(h=>{
      if(!validCoord(h.lat)||!validCoord(h.lng)) return;
      const pos=[Number(h.lat),Number(h.lng)];
      const m=L.marker(pos,{icon:passengerIcon(),zIndexOffset:800,keyboard:false})
        .addTo(state.map).bindPopup(`<b>${escapeHtml(h.people)} Fahrgast${Number(h.people)>1?'gäste':''}</b><br>${escapeHtml(h.category||'Bedarf')}${h.destination?'<br>Ziel: '+escapeHtml(h.destination):''}`);
      state.liveLayers.push(m); liveCoords.push(pos);
    });
    if(liveCoords.length && state.map){
      const bounds=state.map.getBounds();
      const anyVisible=liveCoords.some(pos=>bounds.contains(pos));
      if(!anyVisible){
        if(liveCoords.length===1) state.map.setView(liveCoords[0],Math.max(state.map.getZoom(),15));
        else state.map.fitBounds(liveCoords,{padding:[40,40],maxZoom:15});
      }
    }
  }
  async function refresh(){
    try{ const data=await api('/api/state'); drawState(data); setText('apiStatus','ONLINE'); $('apiStatus').style.color='#39e58c'; }
    catch(e){ setText('apiStatus','OFFLINE'); $('apiStatus').style.color='#ff5d6c'; }
  }
  async function markActivity(){ try{ await api('/api/activity',{method:'POST',body:JSON.stringify({role:state.role,client_id:state.driverId})}); }catch{} }

  let driverAccessPending=null;

  function closeDriverAccessModal(){
    const modal=document.getElementById('driverAccessModal');
    if(modal) modal.hidden=true;
    document.body.classList.remove('modal-open');
  }

  function showDriverAccessError(message){
    const error=document.getElementById('driverAccessError');
    const input=document.getElementById('driverAccessCode');
    if(error) error.textContent=message;
    if(input){ input.select(); input.focus(); }
  }

  async function unlockDriver(){
    if(state.driverToken){
      try{ const v=await api('/api/driver/verify'); if(v.ok) return true; }catch{}
      state.driverToken=''; sessionStorage.removeItem('ht_driver_token');
    }

    if(driverAccessPending) return driverAccessPending;

    driverAccessPending=new Promise(resolve=>{
      const modal=document.getElementById('driverAccessModal');
      const input=document.getElementById('driverAccessCode');
      const error=document.getElementById('driverAccessError');
      const cancel=document.getElementById('driverAccessCancel');
      const submit=document.getElementById('driverAccessSubmit');

      if(!modal||!input||!error||!cancel||!submit){
        driverAccessPending=null;
        resolve(false);
        return;
      }

      error.textContent='';
      input.value='';
      modal.hidden=false;
      document.body.classList.add('modal-open');
      setTimeout(()=>input.focus(),80);

      let busy=false;
      const cleanup=()=>{
        cancel.onclick=null; submit.onclick=null; input.onkeydown=null;
        driverAccessPending=null;
      };
      const cancelAccess=()=>{
        if(busy) return;
        cleanup(); closeDriverAccessModal(); resolve(false);
      };
      const submitAccess=async()=>{
        if(busy) return;
        const code=input.value.trim();
        if(!code){ showDriverAccessError('Bitte Fahrer-Code eingeben.'); return; }
        busy=true; submit.disabled=true; submit.textContent='Prüfe…'; error.textContent='';
        try{
          const r=await api('/api/driver/login',{method:'POST',body:JSON.stringify({code})});
          if(!r?.token) throw new Error('Keine Fahrer-Freigabe erhalten.');
          state.driverToken=r.token;
          sessionStorage.setItem('ht_driver_token',r.token);
          cleanup(); closeDriverAccessModal(); resolve(true);
        }catch(e){
          busy=false; submit.disabled=false; submit.textContent='Freischalten';
          showDriverAccessError(e.message||'Fahrer-Code ist nicht korrekt.');
        }
      };

      cancel.onclick=cancelAccess;
      submit.onclick=submitAccess;
      input.onkeydown=e=>{
        if(e.key==='Enter'){e.preventDefault();submitAccess();}
        if(e.key==='Escape'){e.preventDefault();cancelAccess();}
      };
    });

    return driverAccessPending;
  }

  window.htDriverAccessSubmit=async function(){
    const input=document.getElementById('driverAccessCode');
    const submit=document.getElementById('driverAccessSubmit');
    if(!input||!submit) return;
    const code=input.value.trim();
    if(!code){ showDriverAccessError('Bitte Fahrer-Code eingeben.'); return; }
    submit.disabled=true; submit.textContent='Prüfe…';
    try{
      const r=await api('/api/driver/login',{method:'POST',body:JSON.stringify({code})});
      if(!r?.token) throw new Error('Keine Fahrer-Freigabe erhalten.');
      state.driverToken=r.token;
      sessionStorage.setItem('ht_driver_token',r.token);
      closeDriverAccessModal();
      state.role='driver';
      document.querySelectorAll('.role-btn').forEach(b=>b.classList.toggle('active',b.dataset.role==='driver'));
      document.querySelectorAll('.role-panel').forEach(p=>p.classList.toggle('active',p.id==='driverPanel'));
      document.getElementById('roleLabel').textContent='Fahrer';
      setTimeout(()=>{state.map?.invalidateSize();refresh();},120);
    }catch(e){
      showDriverAccessError(e.message||'Fahrer-Code ist nicht korrekt.');
    }finally{
      submit.disabled=false; submit.textContent='Freischalten';
    }
  };
  window.htDriverAccessCancel=function(){ closeDriverAccessModal(); };

  async function chooseRole(role,{scroll=false}={}){
    if(role==='driver' && !(await unlockDriver())) return;
    setRole(role,{scroll});
  }

  function setRole(role,{scroll=false}={}){
    if(!['passenger','driver'].includes(role)) role='passenger';
    state.role=role; localStorage.setItem('ht_role',role);
    document.querySelectorAll('.role-btn').forEach(b=>b.classList.toggle('active',b.dataset.role===role));
    $('passengerPanel').classList.toggle('active',role==='passenger'); $('driverPanel').classList.toggle('active',role==='driver');
    setText('mapEyebrow',role==='passenger'?'FAHRGAST-MODUS':'FAHRER-MODUS'); setText('mapTitle',role==='passenger'?'Taxis in deiner Nähe':'Live-Bedarf in deiner Nähe');
    document.querySelectorAll('[data-nav-role]').forEach(b=>b.classList.toggle('active',b.dataset.navRole===role));
    markActivity();
    setTimeout(()=>{ try{ state.map && state.map.invalidateSize(); refresh(); }catch{} },120);
    if(scroll){ const panel=role==='passenger'?$('passengerPanel'):$('driverPanel'); panel?.scrollIntoView({behavior:'smooth',block:'start'}); }
  }

  function locate({center=true}={}){
    return new Promise((resolve,reject)=>{
      if(!navigator.geolocation){ reject(new Error('Standort wird von diesem Gerät nicht unterstützt.')); return; }
      navigator.geolocation.getCurrentPosition(pos=>{
        state.userPos={lat:pos.coords.latitude,lng:pos.coords.longitude};
        if(state.userMarker) state.map.removeLayer(state.userMarker);
        state.userMarker=L.marker([state.userPos.lat,state.userPos.lng],{icon:userIcon(),zIndexOffset:1000}).addTo(state.map);
        if(center) state.map.setView([state.userPos.lat,state.userPos.lng],15,{animate:true});
        setTimeout(()=>{ try{ state.map.invalidateSize(); }catch{} },80);
        resolve(state.userPos);
      },err=>reject(new Error(err.code===1?'Standortfreigabe wurde abgelehnt.':'Standort konnte nicht ermittelt werden.')),{enableHighAccuracy:true,timeout:12000,maximumAge:15000});
    });
  }

  async function sendDemand(){
    const btn=$('sendDemandBtn'); btn.disabled=true; setText('passengerMessage','Standort wird ermittelt …');
    try{
      const pos=state.userPos||await locate();
      if(state.hotspotId){ try{await api('/api/hotspots/'+state.hotspotId,{method:'DELETE'});}catch{} }
      const data=await api('/api/hotspots',{method:'POST',body:JSON.stringify({lat:pos.lat,lng:pos.lng,people:Number($('people').value)||1,category:$('category').value,destination:$('destination').value.trim(),note:$('note').value.trim(),time_window:30,service_preference:'taxi'})});
      state.hotspotId=data.hotspot.id; localStorage.setItem('ht_hotspot_id',state.hotspotId); $('cancelDemandBtn').disabled=false;
      const verify=await api('/api/state');
      if(!(verify.hotspots||[]).some(h=>h.id===state.hotspotId)) throw new Error('Bedarf wurde gespeichert, ist aber im LIVE-Status noch nicht sichtbar.');
      drawState(verify); setText('passengerMessage','✓ Geprüft: Bedarf ist in D1 gespeichert und für Fahrer LIVE sichtbar.');
    }catch(e){ setText('passengerMessage','Fehler: '+e.message); }
    finally{ btn.disabled=false; }
  }
  async function cancelDemand(){
    if(!state.hotspotId) return;
    const endedId=state.hotspotId;
    try{
      await api('/api/hotspots/'+endedId,{method:'DELETE'});
      const verify=await api('/api/state');
      if((verify.hotspots||[]).some(h=>h.id===endedId)) throw new Error('Bedarf ist nach dem Beenden noch LIVE sichtbar.');
      state.hotspotId=''; localStorage.removeItem('ht_hotspot_id'); $('cancelDemandBtn').disabled=true;
      drawState(verify); setText('passengerMessage','✓ Geprüft: Bedarf beendet und aus LIVE entfernt.');
    }catch(e){ setText('passengerMessage','Fehler beim Beenden: '+e.message); }
  }

  async function reconcileOwnDemand(){
    if(!state.hotspotId) return;
    try{
      const data=await api('/api/state');
      if(!(data.hotspots||[]).some(h=>h.id===state.hotspotId)){
        state.hotspotId=''; localStorage.removeItem('ht_hotspot_id'); $('cancelDemandBtn').disabled=true;
      } else { $('cancelDemandBtn').disabled=false; }
    }catch{}
  }

  async function driverHeartbeat(){
    if(!state.driverLive) return;
    try{ const pos=await locate({center:false}); await api('/api/vehicles/heartbeat',{method:'POST',body:JSON.stringify({id:state.driverId,lat:pos.lat,lng:pos.lng,providers:['taxi']})}); const verify=await api('/api/state'); if(!(verify.vehicles||[]).some(v=>v.id===state.driverId)) throw new Error('Fahrer wurde gespeichert, ist aber im LIVE-Status noch nicht sichtbar.'); drawState(verify); setText('driverMessage','✓ Geprüft: Taxi ist in D1 gespeichert und LIVE sichtbar.'); }
    catch(e){ setText('driverMessage','LIVE-Fehler: '+e.message); }
  }
  async function goLive(){ state.driverLive=true; $('goLiveBtn').disabled=true; $('goOfflineBtn').disabled=false; setText('driverMessage','LIVE wird aktiviert …'); await driverHeartbeat(); clearInterval(state.heartbeat); state.heartbeat=setInterval(driverHeartbeat,30000); }
  async function goOffline(){ state.driverLive=false; clearInterval(state.heartbeat); try{await api('/api/vehicles/'+state.driverId,{method:'DELETE'});}catch{} $('goLiveBtn').disabled=false; $('goOfflineBtn').disabled=true; setText('driverMessage','Taxi ist offline.'); refresh(); }

  async function share(){
    const data={title:'HOT TRAFFIC TAXI',text:'Taxi-Bedarf live sehen und senden.',url:location.href};
    try{ if(navigator.share) await navigator.share(data); else {await navigator.clipboard.writeText(location.href); alert('Link kopiert.');} }catch{}
  }

  document.querySelectorAll('.role-btn').forEach(b=>b.addEventListener('click',()=>chooseRole(b.dataset.role,{scroll:true})));
  document.querySelectorAll('[data-nav-role]').forEach(b=>b.addEventListener('click',()=>chooseRole(b.dataset.navRole,{scroll:true})));
  $('locateBtn')?.addEventListener('click',async()=>{try{await locate();}catch(e){alert(e.message)}});
  $('sendDemandBtn')?.addEventListener('click',sendDemand); $('cancelDemandBtn')?.addEventListener('click',cancelDemand);
  $('goLiveBtn')?.addEventListener('click',goLive); $('goOfflineBtn')?.addEventListener('click',goOffline);
  $('shareBtn')?.addEventListener('click',share); $('navShare')?.addEventListener('click',share);
  const refreshBtn=$('navRefresh');
  let manualRefreshRunning=false;
  window.htManualRefresh=async function(){
    if(manualRefreshRunning) return false;
    manualRefreshRunning=true;
    const btn=$('navRefresh');
    const old=btn ? btn.innerHTML : '';
    if(btn){ btn.disabled=true; btn.innerHTML='<span>↻</span>LÄDT…'; }
    setText('apiStatus','VERBINDE…');
    try{
      await refresh();
      return true;
    } finally {
      setTimeout(()=>{
        if(btn){ btn.innerHTML=old || '<span>↻</span>Refresh'; btn.disabled=false; }
        manualRefreshRunning=false;
      },700);
    }
  };
  if(refreshBtn) refreshBtn.onclick=window.htManualRefresh;

  if(state.role==='driver' && !state.driverToken) state.role='passenger';
  initMap();
  const brandImg=document.querySelector('.brand-banner-img');
  if(brandImg){ brandImg.addEventListener('load',()=>setTimeout(()=>{try{state.map.invalidateSize()}catch{}},80),{once:true}); }
  setRole(state.role); refresh(); reconcileOwnDemand(); state.refreshTimer=setInterval(()=>{refresh(); reconcileOwnDemand();},15000);
  if(state.hotspotId) $('cancelDemandBtn').disabled=false;
})();
