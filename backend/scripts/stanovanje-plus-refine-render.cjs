// Render the full evidenced floor extent, including balconies beyond wall bounds.
// Keep prior model input crops so checkpointed semantic requests remain reviewable.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require(process.env.STANOVANJE_SHARP_PATH || path.join(require('node:os').homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'));
const root=path.resolve(__dirname,'../logs/stanovanje-plus-ten-20261019');
const codes=process.argv.slice(2);
if(!codes.length){console.log('Usage: node stanovanje-plus-refine-render.cjs <original-code> ...');process.exit(0);}
const selected=new Set(JSON.parse(fs.readFileSync(path.join(root,'selection.json'))).map(s=>s.code));
(async()=>{for(const code of codes){
 if(!selected.has(code))throw Error('Outside original ten: '+code);
 const dir=path.join(root,code),candidate=JSON.parse(fs.readFileSync(path.join(dir,'refinement-candidates.json'))),source=fs.readFileSync(path.join(dir,'source.svg'),'utf8').replace(/style="mix-blend-mode:darken"/g,'');
 const pts=candidate.floor.flatMap(p=>p.outer),oldFrame=JSON.parse(fs.readFileSync(path.join(dir,'frame.json')));
 const b=[Math.min(oldFrame[0],...pts.map(p=>p[0]-5)),Math.min(oldFrame[1],...pts.map(p=>p[1]-5)),Math.max(oldFrame[0]+oldFrame[2],...pts.map(p=>p[0]+5)),Math.max(oldFrame[1]+oldFrame[3],...pts.map(p=>p[1]+5))];
 const frame=[b[0],b[1],b[2]-b[0],b[3]-b[1]],width=2000,height=Math.round(width*frame[3]/frame[2]);
 const reframe=svg=>svg.replace(/viewBox="[^"]+"/,`viewBox="${frame.join(' ')}"`).replace(/width="[^"]+"/,`width="${width}"`).replace(/height="[^"]+"/,`height="${height}"`);
 for(const file of ['source.png','annotated.png','frame.json']){
  const ext=path.extname(file),backup=file.slice(0,-ext.length)+'.original-crop'+ext;
  if(!fs.existsSync(path.join(dir,backup)))fs.copyFileSync(path.join(dir,file),path.join(dir,backup));
 }
 let grid='';const step=frame[2]>300?20:10;
 for(let x=Math.ceil(b[0]/step)*step;x<b[2];x+=step)grid+=`<path d="M${x} ${b[1]}V${b[3]}" stroke="#00aacc" stroke-width=".08" opacity=".4"/><text x="${x+.4}" y="${b[1]+2}" font-size="1.8" fill="#007799">x${x}</text>`;
 for(let y=Math.ceil(b[1]/step)*step;y<b[3];y+=step)grid+=`<path d="M${b[0]} ${y}H${b[2]}" stroke="#00aacc" stroke-width=".08" opacity=".4"/><text x="${b[0]+.4}" y="${y-.3}" font-size="1.8" fill="#007799">y${y}</text>`;
 await sharp(Buffer.from(reframe(source))).flatten({background:'#fff'}).png().toFile(path.join(dir,'source.png'));
 await sharp(Buffer.from(reframe(source).replace('</svg>',grid+'</svg>'))).flatten({background:'#fff'}).png().toFile(path.join(dir,'annotated.png'));
 const overlay=reframe(fs.readFileSync(path.join(dir,'refinement-overlay.svg'),'utf8'));
 fs.writeFileSync(path.join(dir,'refinement-overlay.svg'),overlay);
 await sharp(Buffer.from(overlay)).flatten({background:'#fff'}).png().toFile(path.join(dir,'refinement-overlay.png'));
 fs.writeFileSync(path.join(dir,'frame.json'),JSON.stringify(frame));
 fs.writeFileSync(path.join(dir,'refinement-render.json'),JSON.stringify({code,frame,pixelSize:[width,height],sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'source.svg'))).digest('hex'),basis:'Full original SVG, crop contains complete source-derived floor and measured wall extents plus five source-unit margin',priorSourceCrop:'source.original-crop.png',priorAnnotatedCrop:'annotated.original-crop.png',priorFrame:'frame.original-crop.json'},null,2));
 console.log(code,JSON.stringify(frame));
}})().catch(e=>{console.error(e);process.exit(1)});
