import {DriverPipeline,blendExpression} from './driver-pipeline.mjs';
import {IdleEvents} from './idle-events.mjs';
import {contextOffsets} from './context-motion.mjs';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=t=>t*t*(3-2*t);
export function samplePoints(points,t){
  if(t<=points[0][0])return points[0][1];
  for(let i=1;i<points.length;i++)if(t<=points[i][0]){
    const [a,x]=points[i-1],[b,y]=points[i];return x+(y-x)*smooth(clamp((t-a)/Math.max(1e-8,b-a),0,1));
  }
  return points.at(-1)[1];
}
function bez(a,b,c,d,t){return (1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d;}
export function sampleMotion(s,t){
  let prev=[s[0],s[1]],i=2;
  while(i<s.length){
    const kind=s[i++];let end,c1,c2;
    if(kind===1){c1=s.slice(i,i+2);c2=s.slice(i+2,i+4);end=s.slice(i+4,i+6);i+=6;}
    else{end=s.slice(i,i+2);i+=2;}
    if(t<=end[0]){
      if(kind===0)return prev[1]+(end[1]-prev[1])*clamp((t-prev[0])/Math.max(1e-8,end[0]-prev[0]),0,1);
      if(kind===2)return prev[1];if(kind===3)return end[1];
      let lo=0,hi=1;for(let k=0;k<15;k++){const u=(lo+hi)/2;if(bez(prev[0],c1[0],c2[0],end[0],u)<t)lo=u;else hi=u;}
      return bez(prev[1],c1[1],c2[1],end[1],(lo+hi)/2);
    }prev=end;
  }return prev[1];
}
export class MotionEngine{
  constructor(core,profile,notify){
    this.core=core;this.profile=profile;this.notify=notify;this.params=new Map(profile.allParameters.map(p=>[p.id,p]));
    this.managed=new Set([...profile.parameters.map(p=>p.id),...Array.from({length:13},(_,i)=>`key${i+1}`),...profile.idleMotion.Curves.filter(c=>c.Target==='Parameter').map(c=>c.Id)]);
    this.current=new Map();this.clock=0;this.elapsed=0;this.job=null;this.paused=false;this.idle=true;this.amplitude=1;this.gaze=null;this.frames=0;this.lastStatus='idle';
    this.physicsOutputs=new Set(profile.physicsOutputIds||[]);
    this.sway=false;this.swayStrength=.65;this.swayPeriod=8;this.look={x:0,y:0,hx:0,hy:0};
    this.randomIdle=false;this.idleEvents=new IdleEvents();this.chestGain=1;
    this.pipeline=new DriverPipeline()
      .add('idle',10,c=>this.applyIdle(c)).add('context',15,c=>this.applyContext(c)).add('gaze',20,c=>this.applyGaze(c))
      .add('speech',25,c=>this.applySpeech(c))
      .add('attention',27,c=>this.applyAttention(c))
      .add('motion',30,c=>this.applyMotion(c)).add('blink',40,c=>this.applyBlink(c))
      .add('expression',50,c=>this.applyExpressions(c)).add('commit',60,c=>this.commit(c));
  }
  start(job){
    for(const track of job.compiled.tracks){
      if(!this.params.has(track.id)||this.physicsOutputs.has(track.id))throw new Error(`unwritable driver parameter: ${track.id}`);
    }
    for(const track of job.compiled.tracks)this.managed.add(track.id);
    this.job=job;this.elapsed=0;this.paused=false;this.lastStatus='playing';this.notify('playing',job);
  }
  stop(){this.job=null;this.elapsed=0;this.paused=false;this.lastStatus='idle';}
  tick(deltaMs){
    const wallDt=Math.max(0,deltaMs/1000),dt=Math.min(wallDt,1);this.clock+=wallDt;this.frames++;
    if(this.job&&!this.paused)this.elapsed+=wallDt;
    const target=new Map([...this.managed].map(id=>[id,this.params.get(id)?.default??0]));
    const context={target,set:(id,v)=>target.set(id,v),phase:this.clock,dt,explicit:new Set(),expressions:[]};
    this.pipeline.run(context);
    if(this.job&&this.elapsed>=this.job.compiled.duration){
      const ended=this.job;this.job=null;this.lastStatus='completed';this.notify('completed',ended);
    }
  }
  applyIdle({set,target,phase}){
    if(this.idle){
      set('ParamBreath',.42+.24*Math.sin(phase*1.45));
      set('AngleX',1.15*Math.sin(phase*.55));set('AngleY',.7*Math.sin(phase*.72+.4));set('AngleZ',.6*Math.sin(phase*.48));
      set('PositionX',.5*Math.sin(phase*.55-.2));set('PositionZ',.35*Math.sin(phase*.48-.25));
      const motion=this.profile.idleMotion,t=phase%motion.Meta.Duration;
      for(const c of motion.Curves)if(c.Target==='Parameter')set(c.Id,sampleMotion(c.Segments,t));
      if(this.sway){
        const p=phase*2*Math.PI/clamp(this.swayPeriod,4,16),a=clamp(this.swayStrength,0,1);
        set('PositionX',a*3.2*Math.sin(p));set('PositionY',a*.6*Math.sin(2*p+.4));
        set('PositionZ',a*2*Math.sin(p-.35));
        set('AngleX',a*3*Math.sin(p-.6));set('AngleY',a*1.2*Math.sin(2*p-.3));set('AngleZ',a*2*Math.sin(p-.45));
      }
    }
    const extra=this.idleEvents.sample(phase,this.idle&&this.randomIdle&&!this.job&&!this.speechReserved,this.swayStrength);
    for(const [id,v] of Object.entries(extra))if(this.params.has(id)&&!this.physicsOutputs.has(id))set(id,(target.get(id)??this.params.get(id).default)+v);
  }
  applyGaze({set,target,dt}){
    if(!this.gaze&&Object.values(this.look).every(v=>Math.abs(v)<.00001))return;
    const x=clamp(this.gaze?.x||0,-1,1),y=clamp(this.gaze?.y||0,-1,1),l=this.look;
    l.x+=(x-l.x)*(1-Math.exp(-dt/.09));l.y+=(y-l.y)*(1-Math.exp(-dt/.09));
    l.hx+=(x-l.hx)*(1-Math.exp(-dt/.32));l.hy+=(y-l.hy)*(1-Math.exp(-dt/.32));
    set('ParamEyeBallX',l.x*.65);set('ParamEyeBallY',l.y*.5);
    set('AngleX',(target.get('AngleX')||0)+l.hx*9);set('AngleY',(target.get('AngleY')||0)+l.hy*6);
  }
  applyContext({set,target,phase}){
    if(this.job||this.speechReserved&&this.homeActivity!=='speaking'&&this.homeActivity!=='singing')return;
    const offsets=contextOffsets(this.homeActivity,phase);
    if(!offsets)return;
    for(const [id,offset] of Object.entries(offsets)){
      const param=this.params.get(id);
      if(!param||this.physicsOutputs.has(id))continue;
      // Keep context-only parameters managed so that dropping the lease restores their defaults.
      this.managed.add(id);
      set(id,(target.get(id)??param.default)+offset);
    }
  }
  applySpeech({set}){
    for(const [id,value] of Object.entries(this.speechPose?.values||{}))
      if(this.params.has(id)&&!this.physicsOutputs.has(id))set(id,value);
  }
  applyAttention({set,target,dt}){
    const a=this.attention?.until>this.clock?this.attention:null;
    const l=this.attentionLook??(this.attentionLook={x:0,y:0,weight:0});
    l.weight+=((a?1:0)-l.weight)*(1-Math.exp(-dt/.25));
    if(l.weight<.001)return;
    l.x+=((a?.x||0)-l.x)*(1-Math.exp(-dt/.14));l.y+=((a?.y||0)-l.y)*(1-Math.exp(-dt/.14));
    for(const [id,v] of Object.entries({ParamEyeBallX:l.x*.7,ParamEyeBallY:l.y*.55}))set(id,(target.get(id)||0)*(1-l.weight)+v*l.weight);
    set('AngleX',(target.get('AngleX')||0)+l.x*12*l.weight);set('AngleY',(target.get('AngleY')||0)+l.y*7*l.weight);
  }
  applyMotion({set,explicit,expressions}){
    if(this.job){
      for(const tr of this.job.compiled.tracks){
        const local=this.elapsed-tr.start;
        if(local<0||local>tr.duration)continue;
        if(tr.expression){expressions.push({track:tr,local});explicit.add(tr.id);continue;}
        const p=this.params.get(tr.id),kind=this.job.compiled.steps[tr.action]?.kind;
        let v=samplePoints(tr.points,local);
        if(kind!=='gesture'&&kind!=='expression'&&kind!=='blink')v=p.default+(v-p.default)*this.amplitude;
        set(tr.id,v);explicit.add(tr.id);
      }
    }
  }
  applyBlink({set,explicit,phase}){
    if(this.idle){
      const b=phase%4.7;let open=1;
      if(b>3.8&&b<4.12)open=b<3.91?1-smooth((b-3.8)/.11):smooth(clamp((b-3.96)/.16,0,1));
      for(const id of ['ParamEyeLOpen','ParamEyeROpen'])if(!explicit.has(id))set(id,open);
    }
  }
  applyExpressions({target,set,expressions}){
    this.expressionTelemetry=[];
    for(const {track,local} of expressions){
      const e=track.expression,w=samplePoints(e.weightPoints,local),p=this.params.get(track.id);
      const base=target.get(track.id)??p.default;
      set(track.id,blendExpression(base,e.value,w,e.blend));
      this.expressionTelemetry.push({id:track.id,blend:e.blend,layer:e.layer,weight:+w.toFixed(3),base:+base.toFixed(4)});
    }
  }
  commit({target,dt}){
    if(this.job||this.speechReserved){this.touchInput=null;this.touchBody={x:0,y:0};}
    const body=this.touchBody??(this.touchBody={x:0,y:0}),touch=this.touchInput;
    const chest=touch?.zone==='chest',follow=1-Math.exp(-dt/(chest?.16:.26));
    this.touchHeldTime=chest?(this.touchHeldTime||0)+dt:0;
    this.touchShy=this.job?0:(this.touchShy||0)+((chest?1:0)-(this.touchShy||0))*(1-Math.exp(-dt/(chest?.3:.7)));
    if(this.touchShy>.001){
      const w=this.touchShy;
      // Brief bashful glance, then look back; repeat gently during a long hold.
      const phase=(this.touchHeldTime||0)%6;
      const away=chest?samplePoints([[0,1],[.65,1],[1.6,0],[4.8,0],[5.6,1],[6,1]],phase):0;
      target.set('key7',Math.max(target.get('key7')||0,w*.88));
      for(const [id,value] of Object.entries({ParamEyeBallX:-.4*away*w,ParamEyeBallY:-.32*away*w}))
        target.set(id,(target.get(id)||0)*(1-w)+value);
      target.set('ParamMouthForm',Math.max(target.get('ParamMouthForm')||0,w*.3));
      target.set('AngleY',(target.get('AngleY')||0)-w*3*away);
    }
    body.x+=((chest?touch.x:0)-body.x)*follow;
    body.y+=((chest?touch.y:0)-body.y)*follow;
    if(!this.job)for(const [id,offset] of Object.entries({PositionX:body.x*20,PositionZ:body.x*7,PositionY:body.y*3,LeanInput:-body.y*10,AngleX:body.x*10,AngleY:body.y*8})){
      if(this.params.has(id))target.set(id,(target.get(id)??this.params.get(id).default)+offset);
    }
    if(this.touchInput?.zone==='head'){target.set('AngleX',this.touchInput.x*22);target.set('AngleY',this.touchInput.y*16);target.set('AngleZ',-this.touchInput.x*9);}
    for(const [id,v]of target){
      const p=this.params.get(id);if(!p)continue;
      const prev=this.current.get(id)??p.default,tau=id.includes('Eye')&&id.includes('Open')?.016:.055;
      const value=clamp(prev+(v-prev)*(1-Math.exp(-dt/tau)),p.min,p.max);
      this.current.set(id,value);this.core.setParameterValueById(id,value);
    }
  }
  telemetry(){
    const ids=['ParamBodyAngleX','ParamBodyAngleY','ParamBodyAngleZ','ChestX1','ChestY1','ChestY4','AngleX','AngleY','AngleZ','ParamAngleX','ParamAngleY','ParamAngleZ','ParamEyeLOpen','ParamEyeROpen','ParamMouthForm','ParamMouthOpenY','ParamBreath','Movement1','Movement2','Movement3','PositionX','PositionY','PositionZ','HipAngleX','LEGAngleZ2','Param33','LArm','LForearm','LWrist','LHand','LHand2','RArm','RForearm','RWrist','RHand','RHand2','Param36','Param39','Param41','Param42','Param43','Param62','Param59','Param60','Param61'];
    const observed=[...new Set([...ids,...this.profile.parameters.map(p=>p.id),...this.managed])];
    return {elapsed:+this.elapsed.toFixed(3),frames:this.frames,jobId:this.job?.id??null,status:this.lastStatus,amplitude:this.amplitude,
      driverStages:this.pipeline.names(),expressions:this.expressionTelemetry||[],idleEvent:this.idleEvents.active?.name||null,idleEventCount:this.idleEvents.count,chestGain:this.chestGain,
      nonFinite:this.profile.allParameters.filter(p=>!Number.isFinite(this.core.getParameterValueById(p.id))).map(p=>p.id),
      values:Object.fromEntries(observed.map(id=>[id,+this.core.getParameterValueById(id).toFixed(4)]))};
  }
}
