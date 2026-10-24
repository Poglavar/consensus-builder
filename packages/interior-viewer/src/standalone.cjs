// Shared interior rendering, walking and lifecycle support.
'use strict';
async function mountStandalone(host,architecture,options={}) {
    const {THREE,OrbitControls}=options,env=options.env||globalThis;
    if(!host?.append || !THREE?.WebGLRenderer || !OrbitControls)throw new TypeError('host, THREE and OrbitControls are required');
    if(options.signal?.aborted)throw new Error('Interior mount aborted');
    const scene=new THREE.Scene();scene.background=new THREE.Color(options.background||0xf1f5f6);
    const camera=new THREE.PerspectiveCamera(40,1,.035,1000);camera.up.set(0,0,1);
    const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(env.devicePixelRatio||1,options.maxPixelRatio||2));
    const canvas=renderer.domElement;canvas.tabIndex=0;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',options.labels?.view||'3D interior');host.append(canvas);
    const controls=new OrbitControls(camera,canvas);controls.enableDamping=false;
    const animators=new Set();let frame=null,disposed=false,dirty=true,previous=null,onscreen=true,attachment=null,localPresentation=null;
    const visible=()=>onscreen&&!env.document?.hidden;
    const active=()=>controls.autoRotate||[...animators].some(a=>a.active());
    function schedule(){if(!disposed&&visible()&&frame===null&&(dirty||active()))frame=env.requestAnimationFrame(tick);}
    function render(){dirty=true;schedule();}
    function animate(animator){animators.add(animator);schedule();return ()=>animators.delete(animator);}
    function tick(time){
        frame=null;if(disposed||!visible()){previous=null;return;}
        const dt=previous===null?0:Math.max(0,Math.min(.1,(time-previous)/1000));previous=time;
        for(const animator of animators)if(animator.active())dirty=animator.update(dt)||dirty;
        if(controls.enabled&&controls.autoRotate){controls.update(dt);dirty=true;}
        if(dirty){localPresentation?.update();renderer.render(scene,camera);dirty=false;}
        if(!active())previous=null;schedule();
    }
    const resize=()=>{const w=host.clientWidth,h=host.clientHeight;if(w>0&&h>0){renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();render();}};
    const visibility=()=>{if(!visible()&&frame!==null){env.cancelAnimationFrame(frame);frame=null;previous=null;}render();};
    const stopAutoRotate=()=>{controls.autoRotate=false;render();};
    let resizeObserver=null,intersectionObserver=null;
    function dispose(){
        if(disposed)return;disposed=true;if(frame!==null)env.cancelAnimationFrame(frame);frame=null;animators.clear();
        options.signal?.removeEventListener('abort',dispose);env.document?.removeEventListener('visibilitychange',visibility);
        resizeObserver?.disconnect();intersectionObserver?.disconnect();env.removeEventListener?.('resize',resize);
        canvas.removeEventListener('pointerdown',stopAutoRotate);controls.removeEventListener('change',render);
        localPresentation?.dispose();attachment?.dispose();controls.dispose();renderer.dispose();renderer.forceContextLoss?.();canvas.remove();
    }
    try {
        const api=require('./index.cjs');
        attachment=api.attach({...options,THREE,scene,camera,renderer,controls,host,architecture,render,animate,stopAutoRotate,env});
        const box=new THREE.Box3().setFromObject(attachment.root);
        if(box.isEmpty())throw new Error('Empty interior geometry');
        const size=box.getSize(new THREE.Vector3()),centre=box.getCenter(new THREE.Vector3());
        const extent=Math.max(size.x,size.y,size.z,1),aspect=host.clientWidth/Math.max(host.clientHeight,1);
        const distance=extent/Math.tan(camera.fov*Math.PI/360)/Math.min(1,Math.max(.1,aspect));
        camera.far=Math.max(1000,distance*10);camera.position.copy(centre).addScaledVector(new THREE.Vector3(.85,-1.3,1.05).normalize(),distance);
        controls.target.copy(centre);controls.update();
        scene.add(new THREE.HemisphereLight(0xffffff,0x75838b,2.4));
        const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(-extent,-extent,extent*2);scene.add(light);
        if(options.presentation)localPresentation=api.presentation.mount(attachment,{colors:options.colors,personView:()=>attachment.personView?.active()});
        controls.addEventListener('change',render);canvas.addEventListener('pointerdown',stopAutoRotate);
        if(env.ResizeObserver){resizeObserver=new env.ResizeObserver(resize);resizeObserver.observe(host);}else env.addEventListener?.('resize',resize);
        if(env.IntersectionObserver){intersectionObserver=new env.IntersectionObserver(entries=>{onscreen=entries.some(e=>e.isIntersecting);visibility();});intersectionObserver.observe(host);}
        env.document?.addEventListener('visibilitychange',visibility);options.signal?.addEventListener('abort',dispose,{once:true});resize();render();
        return {...attachment,render,animate,dispose};
    } catch(error){dispose();throw error;}
}
module.exports={mountStandalone};
