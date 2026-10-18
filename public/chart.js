export function drawTrace(canvas,trace,key='gain',metric={},emptyText='选择已完成的测试以查看频率响应') {
 if(!canvas)return;
 const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
 const dpr=window.devicePixelRatio||1;canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
 const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);const w=rect.width,h=rect.height;
 const L=45,R=17,T=22,B=34,pw=w-L-R,ph=h-T-B;
 ctx.font='9px "Segoe UI", "Microsoft YaHei", sans-serif';ctx.lineWidth=1;
 const data=(trace||[]).filter(p=>Number.isFinite(Number(p.frequency))&&Number.isFinite(Number(p[key])));
 let x0=data.length?Number(data[0].frequency):0.5,x1=data.length?Number(data.at(-1).frequency):6;
 if(x1===x0)x1=x0+1;
 let values=data.map(p=>Number(p[key]));let vMin=values.length?Math.min(...values):25,vMax=values.length?Math.max(...values):35;
 const lo=metric.min,hi=metric.max;
 if(Number.isFinite(lo))vMin=Math.min(vMin,lo);if(Number.isFinite(hi))vMax=Math.max(vMax,hi);
 const spread=Math.max((vMax-vMin)*.2,.3);vMin-=spread;vMax+=spread;
 const yStep=(vMax-vMin)/4;
 const X=x=>L+(x-x0)/(x1-x0)*pw,Y=y=>T+(vMax-y)/(vMax-vMin)*ph;
 ctx.fillStyle='#b0bbcd';ctx.textAlign='right';
 for(let i=0;i<=4;i++){let y=T+ph*i/4;ctx.strokeStyle='#edf2f8';ctx.beginPath();ctx.moveTo(L,y);ctx.lineTo(w-R,y);ctx.stroke();ctx.fillText((vMax-yStep*i).toFixed(1),L-9,y+3)}
 ctx.textAlign='center';for(let i=0;i<=5;i++){const x=L+pw*i/5;ctx.fillStyle='#b0bbcd';ctx.fillText((x0+(x1-x0)*i/5).toFixed(1),x,h-15)}
 ctx.textAlign='left';ctx.fillStyle='#a8b5c9';ctx.fillText(metric.unit||'dB',4,10);ctx.textAlign='right';ctx.fillText('频率 / GHz',w-R,h-1);
 ctx.save();ctx.beginPath();ctx.rect(L,T,pw,ph);ctx.clip();
 ctx.strokeStyle='#dbbd90';ctx.setLineDash([4,5]);ctx.lineWidth=.8;
 for(const limit of [lo,hi])if(Number.isFinite(limit)){ctx.beginPath();ctx.moveTo(L,Y(limit));ctx.lineTo(w-R,Y(limit));ctx.stroke()}
 ctx.setLineDash([]);
 if(data.length){const grad=ctx.createLinearGradient(0,T,0,T+ph);grad.addColorStop(0,'rgba(97,139,255,.16)');grad.addColorStop(1,'rgba(97,139,255,0)');ctx.beginPath();ctx.moveTo(X(Number(data[0].frequency)),T+ph);for(const p of data)ctx.lineTo(X(Number(p.frequency)),Y(Number(p[key])));ctx.lineTo(X(Number(data.at(-1).frequency)),T+ph);ctx.closePath();ctx.fillStyle=grad;ctx.fill();ctx.beginPath();data.forEach((p,i)=>i?ctx.lineTo(X(Number(p.frequency)),Y(Number(p[key]))):ctx.moveTo(X(Number(p.frequency)),Y(Number(p[key]))));ctx.strokeStyle='#7295f5';ctx.lineWidth=1.7;ctx.stroke();}
 ctx.restore();
 if(!data.length){ctx.textAlign='center';ctx.fillStyle='#a8b5c9';ctx.font='11px "Microsoft YaHei",sans-serif';ctx.fillText(emptyText,L+pw/2,T+ph/2)}
 canvas._trace={data,key,metric,L,R,T,B,pw,ph,vMin,vMax,x0,x1};
}
