export const IDLE_EVENTS=[
 {name:'换脚调整重心',duration:4.5,values:{PositionX:5,PositionZ:3,AngleZ:2}},
 {name:'轻微前倾',duration:4,values:{LeanInput:4,AngleY:-3,PositionY:-1}},
 {name:'舒展上身',duration:5,values:{PositionY:2.8,AngleY:3,PositionZ:-2}},
 {name:'放松回落',duration:3,values:{PositionY:-2.5,AngleZ:1.8}},
 {name:'深呼吸',duration:5.5,values:{ParamBreath:.35,PositionY:1.5,LeanInput:1.5}},
 {name:'轻轻侧身',duration:4,values:{PositionX:3,PositionZ:-4,AngleX:-3}}
];
export class IdleEvents{
 constructor(random=Math.random){this.random=random;this.next=3;this.active=null;this.last=-1;this.count=0;}
 sample(time,enabled,strength=1){
  if(!enabled){this.active=null;this.next=time+3;return {};}
  if(this.active&&time-this.active.start>=this.active.duration){this.active=null;this.next=time+3+this.random()*6;}
  if(!this.active&&time>=this.next){
   let index=Math.floor(this.random()*(IDLE_EVENTS.length-1));if(index>=this.last)index++;
   index%=IDLE_EVENTS.length;this.last=index;
   this.active={...IDLE_EVENTS[index],start:time,duration:IDLE_EVENTS[index].duration*(.85+this.random()*.3),side:this.random()<.5?-1:1};this.count++;
  }
  if(!this.active)return {};
  const a=this.active,t=Math.max(0,Math.min(1,(time-a.start)/a.duration)),weight=Math.sin(Math.PI*t)**2*strength;
  return Object.fromEntries(Object.entries(a.values).map(([id,v])=>[id,v*weight*(/^(PositionX|PositionZ|AngleX|AngleZ)$/.test(id)?a.side:1)]));
 }
}
export function attachChestPhysics(internal,profile,getGain,getTouch=()=>null){
 const physics=internal.physics;if(!physics?.evaluate)return false;
 const ids=new Set(['ChestX1','ChestX2','ChestX3','ChestXBS','ChestY1','ChestY2','ChestY3','ChestY4']);
 const params=profile.allParameters.filter(p=>ids.has(p.id));
 const original=physics.evaluate;let x=0,y=0,last=performance.now();
 physics.evaluate=function(...args){
  const result=original.apply(this,args),gain=Math.max(1,Math.min(1.8,Number(getGain())||1));
  const now=performance.now(),dt=Math.max(0,Math.min(.1,(now-last)/1000));last=now;
  const touch=getTouch(),active=touch?.zone==='chest',k=1-Math.exp(-dt/(active?.055:.18));
  x+=((active?touch.x*.55:0)-x)*k;y+=((active?touch.y*.45:0)-y)*k;
  if(gain!==1||Math.abs(x)+Math.abs(y)>.0001)for(const p of params){const v=internal.coreModel.getParameterValueById(p.id);internal.coreModel.setParameterValueById(p.id,Math.max(p.min,Math.min(p.max,p.default+(v-p.default)*gain+(p.id.startsWith('ChestX')?x:y))));}
  return result;
 };
 return params.length>0;
}
