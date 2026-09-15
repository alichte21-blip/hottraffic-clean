const API_VERSION='1.0.2-clean';
const json=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json;charset=UTF-8','cache-control':'no-store',...extra}});
const now=()=>Date.now();
const id=()=>crypto.randomUUID();
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const coarse=n=>Math.round(Number(n)*1000)/1000; // ~70–110 m privacy grid
const allowedProviders=new Set(['taxi']);
const allowedPrefs=new Set(['taxi']);
let schemaReady=false;

function requireDb(env){
  if(!env.DB || typeof env.DB.prepare!=='function'){
    const e=new Error('D1 binding "DB" fehlt. In Cloudflare: Worker → Bindings → D1 database → Variable name DB.');
    e.code='DB_BINDING_MISSING';
    throw e;
  }
  return env.DB;
}

async function safeAlter(db,sql){
  try{ await db.prepare(sql).run(); }
  catch(e){
    const m=String(e?.message||e).toLowerCase();
    if(!m.includes('duplicate column')&&!m.includes('already exists')) throw e;
  }
}

async function ensureSchema(env){
  if(schemaReady) return;
  const db=requireDb(env);
  // Self-bootstrapping schema: no manual SQL migration is required for a fresh DB.
  await db.prepare(`CREATE TABLE IF NOT EXISTS hotspots (
    id TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    category TEXT NOT NULL,
    people INTEGER NOT NULL DEFAULT 1,
    desired_time TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    destination TEXT NOT NULL DEFAULT '',
    time_window INTEGER NOT NULL DEFAULT 30,
    service_preference TEXT NOT NULL DEFAULT 'taxi',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  )`).run();
  // Upgrade older Hot Traffic databases safely.
  await safeAlter(db,"ALTER TABLE hotspots ADD COLUMN destination TEXT NOT NULL DEFAULT ''");
  await safeAlter(db,"ALTER TABLE hotspots ADD COLUMN time_window INTEGER NOT NULL DEFAULT 30");
  await safeAlter(db,"ALTER TABLE hotspots ADD COLUMN service_preference TEXT NOT NULL DEFAULT 'taxi'");
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_hotspots_active ON hotspots(status,expires_at)").run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    last_seen INTEGER NOT NULL,
    providers TEXT NOT NULL DEFAULT '[]'
  )`).run();
  await safeAlter(db,"ALTER TABLE vehicles ADD COLUMN providers TEXT NOT NULL DEFAULT '[]'");
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_vehicles_seen ON vehicles(last_seen)").run();

  await db.prepare("CREATE TABLE IF NOT EXISTS demand_events (id TEXT PRIMARY KEY, hotspot_id TEXT, service_preference TEXT NOT NULL DEFAULT 'taxi', people INTEGER NOT NULL DEFAULT 1, category TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS ride_outcomes (id TEXT PRIMARY KEY, hotspot_id TEXT, service_preference TEXT NOT NULL DEFAULT 'taxi', outcome TEXT NOT NULL DEFAULT 'unknown', created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS daily_activity (day TEXT NOT NULL, role TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(day,role,client_id))").run();
  schemaReady=true;
}

function hotspotRow(r){
  return {
    id:r.id,lat:Number(r.lat),lng:Number(r.lng),category:r.category,people:Number(r.people)||1,
    desired_time:r.desired_time||'',note:r.note||'',destination:r.destination||'',
    time_window:Number(r.time_window)||30,service_preference:'taxi',
    created_at:Number(r.created_at),expires_at:Number(r.expires_at),status:r.status||'active'
  };
}

export default {
 async fetch(req,env){
  const u=new URL(req.url);
  if(!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
  try{
   if(u.pathname==='/api/health' && req.method==='GET'){
    await ensureSchema(env);
    const db=requireDb(env);
    const probe=await db.prepare('SELECT 1 AS ok').first();
    return json({ok:Number(probe?.ok)===1,backend:'cloudflare-d1',version:API_VERSION,server_time:now()});
   }

   if(u.pathname==='/api/flights/status' && req.method==='GET'){
    const airport=String(u.searchParams.get('airport')||'Umgebung').slice(0,8);
    return json({configured:false,airport,source:null,events:[]});
   }
   if(u.pathname==='/api/rail/realtime' && req.method==='GET'){
    const upstream=await fetch('https://realtime.gtfs.de/realtime-free.pb',{headers:{'user-agent':'HotTraffic/2.7'}});
    if(!upstream.ok)return json({error:'rail_feed_unavailable',status:upstream.status},502);
    return new Response(upstream.body,{status:200,headers:{'content-type':'application/x-protobuf','cache-control':'public, max-age=8','x-hot-traffic-source':'GTFS.de Realtime · CC BY-SA 4.0'}});
   }

   await ensureSchema(env);
   const db=requireDb(env);

   if(u.pathname==='/api/activity/today' && req.method==='GET'){
    const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const rows=await db.prepare("SELECT role,COUNT(*) AS n FROM daily_activity WHERE day=? GROUP BY role").bind(day).all();
    const counts={driver:0,passenger:0}; (rows.results||[]).forEach(r=>{if(r.role in counts)counts[r.role]=Number(r.n)||0;});
    return json({day,drivers:counts.driver,passengers:counts.passenger,total:counts.driver+counts.passenger});
   }
   if(u.pathname==='/api/activity' && req.method==='POST'){
    const b=await req.json(), role=String(b.role||''), client=String(b.client_id||'').slice(0,100);
    if(!['driver','passenger'].includes(role)||!client)return json({error:'invalid_activity'},400);
    const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    await db.prepare("INSERT OR IGNORE INTO daily_activity (day,role,client_id,created_at) VALUES (?,?,?,?)").bind(day,role,client,now()).run();
    const rows=await db.prepare("SELECT role,COUNT(*) AS n FROM daily_activity WHERE day=? GROUP BY role").bind(day).all();
    const counts={driver:0,passenger:0}; (rows.results||[]).forEach(r=>{if(r.role in counts)counts[r.role]=Number(r.n)||0;});
    return json({day,drivers:counts.driver,passengers:counts.passenger,total:counts.driver+counts.passenger});
   }

   if(u.pathname==='/api/state' && req.method==='GET'){
    const t=now();
    await db.prepare("UPDATE hotspots SET status='expired' WHERE status='active' AND expires_at < ?").bind(t).run();
    await db.prepare('DELETE FROM vehicles WHERE last_seen < ?').bind(t-90000).run();
    const hs=await db.prepare("SELECT id,lat,lng,category,people,desired_time,note,destination,time_window,service_preference,created_at,expires_at,status FROM hotspots WHERE status='active' AND expires_at >= ? ORDER BY created_at DESC LIMIT 500").bind(t).all();
    const vs=await db.prepare("SELECT id,lat,lng,last_seen,providers FROM vehicles WHERE last_seen >= ? LIMIT 500").bind(t-90000).all();
    const vehicles=(vs.results||[]).map(v=>{
      let providers=[]; try{providers=JSON.parse(v.providers||'[]');}catch{}
      providers=Array.isArray(providers)?providers.filter(p=>allowedProviders.has(p)):[];
      return {...v,lat:Number(v.lat),lng:Number(v.lng),last_seen:Number(v.last_seen),providers};
    });
    return json({ok:true,backend:'cloudflare-d1',version:API_VERSION,hotspots:(hs.results||[]).map(hotspotRow),vehicles,server_time:t});
   }

   if(u.pathname==='/api/hotspots' && req.method==='POST'){
    const b=await req.json();
    const lat=Number(b.lat),lng=Number(b.lng),people=clamp(parseInt(b.people)||1,1,99);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return json({error:'location_required'},400);
    const hid=id(), created=now(), expires=created+60*60*1000;
    const pref='taxi';
    await db.prepare('INSERT INTO hotspots (id,lat,lng,category,people,desired_time,note,destination,time_window,service_preference,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(hid,coarse(lat),coarse(lng),String(b.category||'Sonstiges').slice(0,60),people,String(b.desired_time||'').slice(0,5),String(b.note||'').slice(0,120),String(b.destination||'').slice(0,100),clamp(parseInt(b.time_window)||30,15,60),pref,created,expires,'active').run();
    await db.prepare('INSERT INTO demand_events (id,hotspot_id,service_preference,people,category,created_at) VALUES (?,?,?,?,?,?)').bind(id(),hid,pref,people,String(b.category||'Sonstiges').slice(0,60),created).run();
    // Read-after-write is deliberate: success is returned only after D1 can read the row back.
    const saved=await db.prepare("SELECT id,lat,lng,category,people,desired_time,note,destination,time_window,service_preference,created_at,expires_at,status FROM hotspots WHERE id=?").bind(hid).first();
    if(!saved) return json({error:'persistence_failed'},500);
    return json({ok:true,backend:'cloudflare-d1',version:API_VERSION,hotspot:hotspotRow(saved)},201);
   }

   const hm=u.pathname.match(/^\/api\/hotspots\/([a-zA-Z0-9-]+)$/);
   if(hm && req.method==='GET'){
    const row=await db.prepare("SELECT id,lat,lng,category,people,desired_time,note,destination,time_window,service_preference,created_at,expires_at,status FROM hotspots WHERE id=?").bind(hm[1]).first();
    if(!row)return json({error:'not_found'},404);
    return json({ok:true,backend:'cloudflare-d1',version:API_VERSION,hotspot:hotspotRow(row)});
   }
   if(hm && req.method==='PATCH'){
    const b=await req.json(); const people=clamp(parseInt(b.people)||1,1,99);
    const res=await db.prepare("UPDATE hotspots SET people=? WHERE id=? AND status='active'").bind(people,hm[1]).run();
    if(!res?.meta?.changes)return json({error:'not_found_or_inactive'},404);
    return json({ok:true});
   }
   if(hm && req.method==='DELETE'){
    await db.prepare("UPDATE hotspots SET status='ended' WHERE id=?").bind(hm[1]).run();
    return json({ok:true});
   }

   const vm=u.pathname.match(/^\/api\/vehicles\/([a-zA-Z0-9-]+)$/);
   if(vm && req.method==='DELETE'){
    await db.prepare('DELETE FROM vehicles WHERE id=?').bind(vm[1]).run();
    return json({ok:true,id:vm[1],offline:true});
   }

   if(u.pathname==='/api/vehicles/heartbeat' && req.method==='POST'){
    const b=await req.json(); const lat=Number(b.lat),lng=Number(b.lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return json({error:'location_required'},400);
    const vid=String(b.id||id()).slice(0,80), t=now();
    const providers=['taxi'];
    await db.prepare('INSERT INTO vehicles (id,lat,lng,last_seen,providers) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,last_seen=excluded.last_seen,providers=excluded.providers')
      .bind(vid,coarse(lat),coarse(lng),t,JSON.stringify(providers)).run();
    // LIVE is confirmed only after D1 can read the driver back.
    const saved=await db.prepare('SELECT id,lat,lng,last_seen,providers FROM vehicles WHERE id=?').bind(vid).first();
    if(!saved) return json({ok:false,error:'driver_persistence_failed'},500);
    let savedProviders=[]; try{savedProviders=JSON.parse(saved.providers||'[]')}catch{}
    return json({ok:true,backend:'cloudflare-d1',version:API_VERSION,driver:{id:saved.id,lat:Number(saved.lat),lng:Number(saved.lng),last_seen:Number(saved.last_seen),providers:savedProviders}});
   }

   if(u.pathname==='/api/outcomes' && req.method==='POST'){
    const b=await req.json();
    const pref='taxi';
    const outcome=['taxi','other','unknown'].includes(String(b.outcome))?String(b.outcome):'unknown';
    await db.prepare('INSERT INTO ride_outcomes (id,hotspot_id,service_preference,outcome,created_at) VALUES (?,?,?,?,?)').bind(id(),String(b.hotspot_id||'').slice(0,80),pref,outcome,now()).run();
    return json({ok:true});
   }

   if(u.pathname==='/api/admin/summary' && req.method==='GET'){
    const expected=String(env.ADMIN_TOKEN||''); const auth=String(req.headers.get('authorization')||'');
    if(!expected || auth!==`Bearer ${expected}`) return json({error:'unauthorized'},401);
    const since=now()-24*60*60*1000;
    const pref=await db.prepare('SELECT service_preference,COUNT(*) reports,SUM(people) people FROM demand_events WHERE created_at>=? GROUP BY service_preference').bind(since).all();
    const outcomes=await db.prepare('SELECT outcome,COUNT(*) n FROM ride_outcomes WHERE created_at>=? GROUP BY outcome').bind(since).all();
    const active=await db.prepare('SELECT providers FROM vehicles WHERE last_seen>=?').bind(now()-90000).all();
    const providerCounts={taxi:0};
    for(const r of (active.results||[])){let a=[];try{a=JSON.parse(r.providers||'[]')}catch{};for(const x of a)if(x in providerCounts)providerCounts[x]++;}
    const totals=await db.prepare('SELECT COUNT(*) reports,COALESCE(SUM(people),0) people FROM demand_events WHERE created_at>=?').bind(since).first();
    return json({window_hours:24,demand:{reports:Number(totals?.reports||0),people:Number(totals?.people||0),by_preference:pref.results||[]},outcomes:outcomes.results||[],active_drivers:providerCounts,generated_at:now()});
   }

   return json({error:'not_found'},404);
  }catch(e){
    const code=e?.code==='DB_BINDING_MISSING'?'backend_not_configured':'server_error';
    const status=code==='backend_not_configured'?503:500;
    return json({ok:false,error:code,message:String(e?.message||e),version:API_VERSION},status);
  }
 }
};
