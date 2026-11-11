// Independent implementation of explicit ordered stages and exp3 operations.
// References and adoption boundaries: research/adoption-manifest.json.
export class DriverPipeline {
  constructor(){this.stages=[];}
  add(name,order,run){
    if(this.stages.some(s=>s.name===name))throw new Error(`duplicate driver stage: ${name}`);
    if(!Number.isFinite(order)||typeof run!=='function')throw new Error('invalid driver stage');
    this.stages.push({name,order,run});this.stages.sort((a,b)=>a.order-b.order);
    return this;
  }
  run(context){for(const stage of this.stages)stage.run(context);}
  names(){return this.stages.map(s=>s.name);}
}
export function blendExpression(base,value,weight,mode){
  if(![base,value,weight].every(Number.isFinite))throw new Error('non-finite expression');
  const w=Math.max(0,Math.min(1,weight));
  if(mode==='Add')return base+value*w;
  if(mode==='Multiply')return base*(1+(value-1)*w);
  if(mode==='Overwrite')return base+(value-base)*w;
  throw new Error(`unknown expression blend: ${mode}`);
}
