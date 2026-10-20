// Apartment and building-context previews from source-backed models; review status is shown alongside.
(function (root) {
    'use strict';
    const SVG = 'http://www.w3.org/2000/svg';
    const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
    const svg = (tag, attrs = {}) => { const n = document.createElementNS(SVG, tag); Object.entries(attrs).forEach(([k,v]) => n.setAttribute(k, String(v))); return n; };
    function mountExpandable(panel, heading) {
        const label=heading.textContent,button=el('button','viewer-expand');button.type='button';button.setAttribute('aria-haspopup','dialog');
        const icon=svg('svg',{viewBox:'0 0 24 24','aria-hidden':'true',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round'}),path=svg('path');
        icon.append(path);button.append(icon);heading.append(button);
        let dialog=null,placeholder=null;
        function update(expanded){
            const text=expanded?'Smanji prikaz':'Proširi prikaz';
            button.setAttribute('aria-label',text);button.setAttribute('title',text);button.setAttribute('aria-expanded',String(expanded));
            path.setAttribute('d',expanded?'M4 9h5V4m6 0v5h5M4 15h5v5m6 0v-5h5':'M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5');
        }
        function restore(){
            if(!dialog)return;
            const previous=dialog;dialog=null;
            previous.removeEventListener('close',restore);
            placeholder.replaceWith(panel);placeholder=null;
            previous.remove();document.body.classList.remove('viewer-expanded');update(false);button.focus();
        }
        function toggle(){
            if(dialog){dialog.close();return;}
            placeholder=el('div',panel.className);placeholder.setAttribute('aria-hidden','true');panel.before(placeholder);
            dialog=el('dialog','viewer-dialog');dialog.setAttribute('aria-label',label);dialog.append(panel);document.body.append(dialog);
            dialog.addEventListener('close',restore);document.body.classList.add('viewer-expanded');update(true);dialog.showModal();button.focus();
        }
        update(false);button.addEventListener('click',toggle);
        return {dispose(){if(dialog){dialog.close();restore();}button.removeEventListener('click',toggle);button.remove();}};
    }
    function planSvg(apartment) {
        const a = apartment?.architecture;
        if (!a || !Array.isArray(a.dimensionsM) || a.dimensionsM.length !== 2) return null;
        const [w,h] = a.dimensionsM, pad = Math.max(w,h)*.04, root = svg('svg', { viewBox:`${-pad} ${-pad} ${w+2*pad} ${h+2*pad}`, role:'img', 'aria-label':'Tlocrt stana' });
        const path = rings => rings.map(ring => ring.map((p,i)=>`${i?'L':'M'}${Number(p[0])*w} ${Number(p[1])*h}`).join(' ')+' Z').join(' ');
        for (const rings of a.slabs || []) root.append(svg('path',{d:path(rings),fill:'#e6e2d8','fill-rule':'evenodd'}));
        for (const rings of a.walls || []) root.append(svg('path',{d:path(rings),fill:'#444b46','fill-rule':'evenodd'}));
        for (const opening of a.openings || []) if (opening.a && opening.b) root.append(svg('line',{x1:opening.a[0]*w,y1:opening.a[1]*h,x2:opening.b[0]*w,y2:opening.b[1]*h,stroke:opening.kind==='door'?'#d99b34':'#7aa99b','stroke-width':Math.max(w,h)*.009}));
        return root;
    }
    function mountPlan(host, apartment) {
        host.replaceChildren(); const shape = planSvg(apartment);
        if (!shape) { host.append(Object.assign(el('p','viewer-copy'),{textContent:'Tlocrt nije dostupan za ovaj stan.'})); return { dispose(){} }; }
        host.append(shape); return { dispose(){ host.replaceChildren(); } };
    }
    function envelopeGroup(THREE, model, apartment) {
        const api = root.__siteModelGeometry, frame = api?.localFrame(model);
        if (!frame || !model?.envelope?.footprint) return null;
        const group = new THREE.Group(); group.userData.cbFloorPlan = true;
        const footprint = api.storeyPrisms(model);
        for (const floor of footprint) {
            const shape = new THREE.Shape(floor.ring.map(p=>new THREE.Vector2(p[0],p[1])));
            const geometry = new THREE.ExtrudeGeometry(shape,{depth:floor.z1-floor.z0,bevelEnabled:false});
            geometry.translate(0,0,floor.z0);
            const material = new THREE.MeshPhongMaterial({color:floor.estimated?0xd8c29f:0xb9c9bd,transparent:true,opacity:.24,side:THREE.DoubleSide,depthWrite:false});
            group.add(new THREE.Mesh(geometry,material));
        }
        const placement = apartment?.placement, best = placement?.best;
        const floor = Number.isFinite(apartment?.floor) ? (model.envelope.storeys||[]).find(s=>s.level===apartment.floor) : null;
        const transform=root.NovogradnjeCatalogue.placementTransform(best,apartment?.architecture?.dimensionsM);
        if (placement?.status === 'placed' && transform && apartment.architecture && floor && Number.isFinite(floor.elevationM)) {
            const unit = root.__threeFloorPlans.createLocalUnitGroup(THREE,apartment.architecture,root.__buildingFloorPlans);
            unit.scale.set(transform.scale,transform.scale,1); unit.rotation.z=transform.rotation; unit.position.set(transform.x,transform.y,floor.elevationM);
            group.add(unit);
        }
        return group;
    }
    function mountEnvelope(host, model, apartment) {
        host.replaceChildren();
        if (!model?.envelope?.footprint || !model?.envelope?.storeys?.length || !root.__floorPlanReviewRenderer) {
            const p=el('p','viewer-copy');p.textContent='Prikaz zgrade nije dostupan za ovu lokaciju.';host.append(p);return {dispose(){}};
        }
        let dispose=null, cancelled=false;
        const stopLoading=root.NovogradnjeLoading.start(host,'Učitavanje 3D prikaza zgrade…');
        root.__floorPlanReviewRenderer.preview(host,THREE=>envelopeGroup(THREE,model,apartment),()=>!cancelled).then(fn=>{if(cancelled)fn?.();else dispose=fn;}).catch(()=>{if(!cancelled){const p=el('p','viewer-copy');p.textContent='3D prikaz zgrade nije dostupan u ovom pregledniku.';host.replaceChildren(p);}}).finally(stopLoading);
        return {dispose(){cancelled=true;stopLoading();dispose?.();host.replaceChildren();}};
    }
    function contextGroup(THREE, model, context) {
        const frame = root.__siteModelGeometry.localFrame(model);
        if (!frame || !Number.isFinite(context.groundZ)) return null;
        const group = new THREE.Group(); group.userData.cbFloorPlan = true;
        const material = new THREE.MeshPhongMaterial({color:0xb8c2bf,side:THREE.DoubleSide,shininess:8});
        let count = 0;
        for (const building of context.buildings || []) {
            const mesh = root.ContextBuildings3D.buildMeshFromBuilding(building, material, (lng,lat)=>frame.toLocal([lng,lat]), THREE);
            if (!mesh) continue;
            mesh.position.z = building.z_min - context.groundZ;
            group.add(mesh); count++;
        }
        if (!count) material.dispose();
        const target = new THREE.Group(); target.name='context-project';
        const footprint=model.envelope.footprint;
        const polygons=footprint.type==='MultiPolygon'?footprint.coordinates:[footprint.coordinates];
        for(const coordinates of polygons){
            const part=envelopeGroup(THREE,{...model,envelope:{...model.envelope,footprint:{type:'Polygon',coordinates}}},null);
            if(!part)continue;
            // Each envelope uses its first vertex as origin; place every part in the shared site frame.
            const offset=frame.toLocal(coordinates[0][0]);part.position.set(offset[0],offset[1],0);target.add(part);
        }
        if (target.children.length) {
            target.traverse(child=>{if(child.isMesh){child.material.color.set(0xe2a434);child.material.opacity=.92;child.material.depthWrite=true;}});
            group.add(target);
        }
        const box = new THREE.Box3().setFromObject(group), size = box.getSize(new THREE.Vector3());
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(size.x+20,50),Math.max(size.y+20,50)),new THREE.MeshPhongMaterial({color:0xe5e9e3,side:THREE.DoubleSide}));
        const centre = box.getCenter(new THREE.Vector3()); ground.position.set(centre.x,centre.y,Math.min(box.min.z,0)-.15);group.add(ground);
        return group;
    }
    function mountContext(host, project) {
        if (!Number.isFinite(project?.location?.lng) || !Number.isFinite(project?.location?.lat) ||
            !['Polygon', 'MultiPolygon'].includes(project?.model?.envelope?.footprint?.type)) {
            host.replaceChildren(Object.assign(el('p','viewer-copy'),{textContent:'Nepoznata lokacija — okolica se ne može prikazati.'}));
            return {dispose(){host.replaceChildren();}};
        }
        const stage=el('div','context-stage'),view=el('div','context-canvas'),toolbar=el('div','context-controls');
        toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','Prikaz okolice');
        const modelButton=el('button','context-mode'),googleButton=el('button','context-mode');
        modelButton.type=googleButton.type='button';modelButton.textContent='Model';googleButton.textContent='Google 3D';
        toolbar.append(modelButton,googleButton);stage.append(view,toolbar);host.replaceChildren(stage);
        let cancelled=false,dispose=null,controller=null,generation=0,mode=null,context=null,stopLoading=null;
        async function show(next){
            if(cancelled||mode===next)return;
            mode=next;const token=++generation;controller?.abort();stopLoading?.();dispose?.();dispose=null;
            const current=()=>!cancelled&&token===generation;
            modelButton.setAttribute('aria-pressed',String(next==='model'));googleButton.setAttribute('aria-pressed',String(next==='google'));
            view.replaceChildren();
            const stop=root.NovogradnjeLoading.start(view,next==='google'?'Učitavanje Google 3D prikaza…':'Učitavanje neposredne okolice…');
            stopLoading=stop;
            controller=new AbortController();
            try {
                if(next==='google'){
                    const result=await root.NovogradnjeGoogleContext.mount(view,project,current,{groundZ:context?.groundZ,signal:controller.signal});
                    if(!current())result?.();else dispose=result;
                    return;
                }
                if(!context){
                const response=await fetch(`/novogradnje/api/projects/${encodeURIComponent(project.id)}/context`,{signal:controller.signal});
                if(!response.ok)throw new Error('Context unavailable');
                context=await response.json();
                }
                if(!current())return;
                if(!context.buildings?.length || !Number.isFinite(context.groundZ))throw new Error('No surveyed neighbours');
                const fn=await root.__floorPlanReviewRenderer.preview(view,THREE=>contextGroup(THREE,project.model,context),current,
                    {enablePan:false,enableZoom:true,minPolarAngle:.15,maxPolarAngle:Math.PI*.48,focusName:'context-project'});
                if(!current())fn?.();else dispose=fn;
            } catch(error) {
                if(current()){
                    mode=null;
                    view.replaceChildren(Object.assign(el('p','viewer-copy'),{textContent:next==='google'?'Google 3D trenutačno nije dostupan. Pokušaj ponovno ili odaberi Model.':'3D prikaz okolice trenutačno nije dostupan.'}));
                }
            } finally {
                stop();if(current())stopLoading=null;
            }
        }
        modelButton.addEventListener('click',()=>show('model'));googleButton.addEventListener('click',()=>show('google'));
        show(new URLSearchParams(root.location?.search||'').get('context')==='google'?'google':'model');
        return {dispose(){cancelled=true;generation++;controller?.abort();stopLoading?.();dispose?.();host.replaceChildren();}};
    }
    function mountApartment(host, apartment, options={}) {
        host.className+=' apartment-lit-host';
        host.replaceChildren(); const view = el('div','viewer-canvas'); host.append(view);
        const actions = el('div','viewer-actions'), button=el('button','view-toggle');button.type='button';button.textContent='Prikaži u 3D';actions.append(button);host.append(actions);
        let current=null, is3d=Boolean(apartment?.architecture), generation=0, interacted=false, stopLoading=null;
        async function show3d(){
            const token=++generation;
            view.replaceChildren();
            if(!apartment?.architecture){const p=el('p','viewer-copy');p.textContent='3D rekonstrukcija nije dostupna za ovaj stan.';view.append(p);return;}
            const renderer=root.__floorPlanReviewRenderer, three=root.__threeFloorPlans, plans=root.__buildingFloorPlans;
            const stop=root.NovogradnjeLoading.start(view,'Učitavanje 3D prikaza stana…');
            stopLoading=stop;
            try { const dispose=await renderer.preview(view,THREE=>three.createLocalUnitGroup(THREE,apartment.architecture,plans),()=>token===generation,{
                autoRotate:!interacted,autoRotateSpeed:.35,onInteraction(){interacted=true;},
                setup(context){
                    const disposePeople=root.__apartmentPeople.mount({...context,host:view,architecture:apartment.architecture});
                    let disposeSun;
                    try{disposeSun=root.__apartmentSun.mount({...context,host:view,controlsHost:host,architecture:apartment.architecture,placement:apartment.placement,location:options.location});}
                    catch(error){disposePeople();throw error;}
                    return ()=>{disposeSun();disposePeople();};
                }
            });if(token!==generation){dispose?.();return;}current={dispose(){generation++;dispose?.();}}; }
            catch { if(token!==generation)return;const p=el('p','viewer-copy');p.textContent='3D prikaz nije dostupan u ovom pregledniku.';view.replaceChildren(p);current={dispose(){}}; }
            finally {stop();if(token===generation)stopLoading=null;}
        }
        function show2d(){stopLoading?.();stopLoading=null;current=mountPlan(view,apartment);}
        button.textContent=is3d?'Prikaži 2D':'Prikaži u 3D';
        if(is3d)show3d();else show2d();
        button.addEventListener('click',async()=>{
            stopLoading?.();stopLoading=null;current?.dispose(); generation++;
            is3d=!is3d;button.textContent=is3d?'Prikaži 2D':'Prikaži u 3D';
            if(is3d)await show3d();else show2d();
        });
        return {dispose(){generation++;stopLoading?.();current?.dispose();host.replaceChildren();}};
    }
    root.NovogradnjeViewer={mountPlan,mountApartment,mountEnvelope,mountContext,mountExpandable};
})(window);
