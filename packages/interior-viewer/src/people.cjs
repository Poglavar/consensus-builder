// Shared interior rendering, walking and lifecycle support.
    'use strict';
    // The overview animates people at a calm 30 fps; the eye-level view follows them every frame.
    const OVERVIEW_STEP_S = 1 / 30;
    function createFigure(THREE, female) {
        const group=new THREE.Group(),height=female?1.67:1.78,g=height/1.75;
        group.name=female?'ApartmentPerson:female':'ApartmentPerson:male';
        // Same cylinder/sphere silhouette and proportions as three-life.js, without its traffic stack.
        const skin=new THREE.MeshPhongMaterial({color:0xdfb28b,shininess:8});
        const shirt=new THREE.MeshPhongMaterial({color:female?0xb55c56:0x46688c,shininess:8});
        const trousers=new THREE.MeshPhongMaterial({color:0x39424c,shininess:8});
        const hair=new THREE.MeshPhongMaterial({color:female?0x593d2c:0x3c3028,shininess:8});
        const limbGeometry=new THREE.CylinderGeometry(1,1,1,7).rotateX(Math.PI/2).translate(0,0,-.5);
        const torsoGeometry=new THREE.CylinderGeometry(female?.16:.17,.14,.62,9).rotateX(Math.PI/2).translate(0,0,.31);
        const torso=new THREE.Mesh(torsoGeometry,shirt);torso.position.set(0,0,.81*g);torso.scale.set(g,g,g);group.add(torso);
        const headGeometry=new THREE.SphereGeometry(.12,10,8),head=new THREE.Mesh(headGeometry,skin);
        head.position.set(0,0,1.62*g);head.scale.set(g,g,g);group.add(head);
        const hairGeometry=new THREE.SphereGeometry(.126,10,8,0,Math.PI*2,0,Math.PI*.6).rotateX(Math.PI/2);
        const cap=new THREE.Mesh(hairGeometry,hair);cap.position.copy(head.position);cap.scale.set(g,g,g);group.add(cap);
        if(female){const back=new THREE.Mesh(new THREE.SphereGeometry(.1,8,6),hair);back.scale.set(.8*g,1.15*g,1.5*g);back.position.set(-.045*g,0,1.57*g);group.add(back);}
        const limbs=[];
        for(const [side,index] of [[1,0],[-1,1]]) {
            const leg=new THREE.Mesh(limbGeometry,trousers);leg.position.set(0,side*.1*g,.81*g);leg.scale.set(.065*g,.065*g,.8*g);group.add(leg);
            const arm=new THREE.Mesh(limbGeometry,shirt);arm.position.set(0,side*.235*g,1.4*g);arm.scale.set(.045*g,.045*g,.59*g);group.add(arm);
            limbs.push({leg,arm,sign:index?-1:1});
        }
        // People receive shadows but cast none, so walking never forces a shadow-map redraw.
        group.traverse(object=>{if(object.isMesh)object.userData.noShadow=true;});
        function pose(walker,standing=false) {
            group.position.set(walker.x,walker.y,.01);group.rotation.z=walker.heading;
            const swing=!standing&&walker.moving?Math.sin(walker.phase)*.35:0;
            for(const limb of limbs){limb.leg.rotation.y=swing*limb.sign;limb.arm.rotation.y=-swing*.8*limb.sign;}
        }
        return {group,pose,eyeHeight:1.62*g};
    }
    function mount({THREE,group,render,animate,host,architecture,camera,controls,renderer,stopAutoRotate,quality,labels},env=globalThis) {
        const navigation=require('./navigation.cjs');
        const nav=navigation.buildNavigation(architecture),walkers=navigation.createWalkers(nav);
        if(!walkers.length)return ()=>{};
        const people=new THREE.Group();people.name='ApartmentPeople';group.add(people);
        const figures=walkers.map((walker,index)=>{const figure=createFigure(THREE,index===1);people.add(figure.group);figure.pose(walker);return figure;});
        const media=env.matchMedia?.('(prefers-reduced-motion: reduce)');
        let disposed=false,reduced=Boolean(media?.matches),elapsed=0;
        const poseAll=standing=>figures.forEach((figure,index)=>figure.pose(walkers[index],standing));
        const moveTo=(walker,point)=>{
            walker.controlled=false;
            if(!navigation.routeWalkerTo(nav,walker,point))return false;
            if(reduced){
                // Reduced motion jumps along the same validated route, without an animation.
                for(let i=0;walker.path.length&&i<20000;i++)navigation.advanceWalkers(nav,walkers,.1);
                poseAll(true);personView?.update();render();
            }
            return true;
        };
        const step=(walker,dx,dy)=>navigation.stepWalker(nav,walker,dx,dy,walkers);
        const personView=camera?require('./walking.cjs').mount({THREE,group,figures,walkers,camera,controls,renderer,render,animate,host,stopAutoRotate,moveTo,step,labels,coarse:Boolean(quality?.coarse)},env):null;
        const removeAnimator=animate({active:()=>!disposed&&!reduced,update(dt){
            elapsed+=dt;
            if(!personView?.active()&&elapsed<OVERVIEW_STEP_S)return false;
            const changed=navigation.advanceWalkers(nav,walkers,elapsed);elapsed=0;
            if(changed){poseAll(false);personView?.update();}
            return changed;
        }});
        function motionChanged(){reduced=Boolean(media.matches);poseAll(true);render();}
        media?.addEventListener('change',motionChanged);
        render();
        const dispose=function() {
            if(disposed)return;disposed=true;removeAnimator();media?.removeEventListener('change',motionChanged);
            personView?.dispose();group.remove(people);
            const geometries=new Set(),materials=new Set();
            people.traverse(object=>{if(object.geometry)geometries.add(object.geometry);if(object.material)materials.add(object.material);});
            geometries.forEach(geometry=>geometry.dispose());materials.forEach(material=>material.dispose());
        };
        dispose.personView=personView;dispose.navigation=nav;dispose.walkers=walkers;return dispose;
    }
    module.exports = {mount,createFigure};
