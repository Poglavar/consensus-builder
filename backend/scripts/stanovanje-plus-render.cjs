// Render bounded, local evidence images using the already installed runtime Sharp package.
const fs=require('node:fs'),path=require('node:path');
const sharp=require(process.env.STANOVANJE_SHARP_PATH || path.join(require('node:os').homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'));
const root=path.resolve(__dirname,'../logs/stanovanje-plus-ten-20261019');
(async()=>{for(const source of JSON.parse(fs.readFileSync(path.join(root,'selection.json')))){
 const dir=path.join(root,source.code),svg=fs.readFileSync(path.join(dir,'source.svg'),'utf8').replace(/style="mix-blend-mode:darken"/g,''),e=JSON.parse(fs.readFileSync(path.join(dir,'evidence.json')));
 const walls=Object.entries(e.layers).filter(([name])=>/nosiv|zid|konstruk/i.test(name));
 if(!walls.length)throw Error('No architectural layers');
 const b=[Math.min(...walls.map(([,v])=>v.bounds[0]))-5,Math.min(...walls.map(([,v])=>v.bounds[1]))-5,Math.max(...walls.map(([,v])=>v.bounds[2]))+5,Math.max(...walls.map(([,v])=>v.bounds[3]))+5];
 const frame=[b[0],b[1],b[2]-b[0],b[3]-b[1]];
 let crop=svg.replace(/viewBox="[^"]+"/,`viewBox="${frame.join(' ')}"`).replace(/width="[^"]+"/,`width="1800"`).replace(/height="[^"]+"/,`height="${Math.round(1800*frame[3]/frame[2])}"`);
 let grid='';const step=frame[2]>300?20:10;
 for(let x=Math.ceil(b[0]/step)*step;x<b[2];x+=step)grid+=`<path d="M${x} ${b[1]}V${b[3]}" stroke="#00aacc" stroke-width=".08" opacity=".4"/><text x="${x+.4}" y="${b[1]+2}" font-size="1.8" fill="#007799">x${x}</text>`;
 for(let y=Math.ceil(b[1]/step)*step;y<b[3];y+=step)grid+=`<path d="M${b[0]} ${y}H${b[2]}" stroke="#00aacc" stroke-width=".08" opacity=".4"/><text x="${b[0]+.4}" y="${y-.3}" font-size="1.8" fill="#007799">y${y}</text>`;
 await sharp(Buffer.from(crop)).flatten({background:'#fff'}).png().toFile(path.join(dir,'source.png'));
 await sharp(Buffer.from(crop.replace('</svg>',grid+'</svg>'))).flatten({background:'#fff'}).png().toFile(path.join(dir,'annotated.png'));
 await sharp(Buffer.from(svg),{density:200}).resize({width:2400}).flatten({background:'#fff'}).png().toFile(path.join(dir,'source-full.png'));
 fs.writeFileSync(path.join(dir,'frame.json'),JSON.stringify(frame));console.log(source.code,frame);
}})().catch(e=>{console.error(e);process.exit(1)});
