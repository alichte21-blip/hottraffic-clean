(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    role: localStorage.getItem('ht_role') || 'passenger', map: null, userPos: null, userMarker: null,
    liveLayers: [], hotspotId: localStorage.getItem('ht_hotspot_id') || '',
    driverId: localStorage.getItem('ht_driver_id') || crypto.randomUUID(),
    driverLive: false, heartbeat: null, refreshTimer: null
  };
  localStorage.setItem('ht_driver_id', state.driverId);

  function setText(id, text){ const el=$(id); if(el) el.textContent=text; }
  function escapeHtml(s=''){ return String(s).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  async function api(path, options={}){
    const res = await fetch(path,{cache:'no-store',headers:{'content-type':'application/json',...(options.headers||{})},...options});
    let data={}; try{ data=await res.json(); }catch{}
    if(!res.ok) throw new Error(data.message||data.error||`HTTP ${res.status}`);
    return data;
  }

  function taxiIcon(){ return L.divIcon({className:'taxi-marker',iconSize:[44,28],iconAnchor:[22,14],html:'<div class="taxi-pin"><i class="roof"></i><i class="body"></i><i class="wheel w1"></i><i class="wheel w2"></i></div>'}); }
  function passengerIcon(){ return L.divIcon({className:'passenger-marker',iconSize:[36,48],iconAnchor:[18,42],html:'<div class="passenger-pin"><i class="halo"></i><i class="person"></i><i class="bag"></i></div>'}); }
  function userIcon(){ return L.divIcon({className:'user-marker',iconSize:[18,18],iconAnchor:[9,9],html:'<div class="user-dot"></div>'}); }

  function initMap(){
    state.map=L.map('map',{zoomControl:true,attributionControl:true}).setView([52.5200,13.4050],12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{maxZoom:20,attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(state.map);
  }
  function clearLive(){ state.liveLayers.forEach(x=>state.map.removeLayer(x)); state.liveLayers=[]; }
  function drawState(data){
    clearLive(); const hs=data.hotspots||[], vs=data.vehicles||[];
    setText('driverCount',vs.length); setText('demandCount',hs.length);
    vs.forEach(v=>{ const m=L.marker([v.lat,v.lng],{icon:taxiIcon(),zIndexOffset:500}).addTo(state.map).bindPopup('<b>Taxi LIVE</b><br>Zuletzt aktualisiert'); state.liveLayers.push(m); });
    hs.forEach(h=>{ const m=L.marker([h.lat,h.lng],{icon:passengerIcon(),zIndexOffset:600}).addTo(state.map).bindPopup(`<b>${escapeHtml(h.people)} Fahrgast${Number(h.people)>1?'gäste':''}</b><br>${escapeHtml(h.category||'Bedarf')}${h.destination?'<br>Ziel: '+escapeHtml(h.destination):''}`); state.liveLayers.push(m); });
  }
  async function refresh(){
    try{ const data=await api('/api/state'); drawState(data); setText('apiStatus','ONLINE'); $('apiStatus').style.color='#39e58c'; }
    catch(e){ setText('apiStatus','OFFLINE'); $('apiStatus').style.color='#ff5d6c'; }
  }
  async function markActivity(){ try{ await api('/api/activity',{method:'POST',body:JSON.stringify({role:state.role,client_id:state.driverId})}); }catch{} }

  function setRole(role,{scroll=false}={}){
    if(!['passenger','driver'].includes(role)) role='passenger';
    state.role=role; localStorage.setItem('ht_role',role);
    document.querySelectorAll('.role-btn').forEach(b=>b.classList.toggle('active',b.dataset.role===role));
    $('passengerPanel').classList.toggle('active',role==='passenger'); $('driverPanel').classList.toggle('active',role==='driver');
    setText('mapEyebrow',role==='passenger'?'FAHRGAST-MODUS':'FAHRER-MODUS'); setText('mapTitle',role==='passenger'?'Taxis in deiner Nähe':'Live-Bedarf in deiner Nähe');
    document.querySelectorAll('[data-nav-role]').forEach(b=>b.classList.toggle('active',b.dataset.navRole===role));
    markActivity();
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

  document.querySelectorAll('.role-btn').forEach(b=>b.addEventListener('click',()=>setRole(b.dataset.role,{scroll:true})));
  document.querySelectorAll('[data-nav-role]').forEach(b=>b.addEventListener('click',()=>setRole(b.dataset.navRole,{scroll:true})));
  $('locateBtn').addEventListener('click',async()=>{try{await locate();}catch(e){alert(e.message)}});
  $('sendDemandBtn').addEventListener('click',sendDemand); $('cancelDemandBtn').addEventListener('click',cancelDemand);
  $('goLiveBtn').addEventListener('click',goLive); $('goOfflineBtn').addEventListener('click',goOffline);
  $('shareBtn').addEventListener('click',share); $('navShare').addEventListener('click',share); $('navRefresh').addEventListener('click',refresh);

  initMap(); setRole(state.role); refresh(); reconcileOwnDemand(); state.refreshTimer=setInterval(()=>{refresh(); reconcileOwnDemand();},15000);
  if(state.hotspotId) $('cancelDemandBtn').disabled=false;
})();
