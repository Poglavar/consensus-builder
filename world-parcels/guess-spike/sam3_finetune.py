#!/usr/bin/env python3
"""Small offline decoder/mask-head fine-tune with geographic validation and held-out evaluation."""
import argparse
import gc
import hashlib
import html
from importlib.metadata import version
import json
import os
from pathlib import Path
import random
import time

import numpy as np
from PIL import Image
import torch
from transformers import Sam3Model, Sam3Processor
from transformers.models.sam3.modeling_sam3 import Sam3VisionEncoderOutput
from transformers.modeling_outputs import BaseModelOutputWithPooling
from huggingface_hub import snapshot_download

from evaluate import rasterize_reference, boundary, score_boundaries
from sam3_compare import evaluate_masks, evaluate_instances, make_comparison, log
from sam3_losses import parcel_loss

REVISION = '3c879f39826c281e95690f02c7821c4de09afae7'
PROMPTS = ['land parcel', 'residential plot', 'agricultural field']
PREFIXES = ('detr_decoder.', 'dot_product_scoring.', 'mask_decoder.')
SEED = 20261002


def save(value, path):
    temporary = path.with_suffix(path.suffix+'.tmp')
    torch.save(value, temporary)
    os.replace(temporary, path)


def json_save(value, path):
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value, indent=2))
    os.replace(temporary, path)


def adaptation(model):
    return {name: p.detach().cpu().clone() for name,p in model.named_parameters()
            if name.startswith(PREFIXES)}


def apply_adaptation(model, values):
    expected = {name for name,_ in model.named_parameters() if name.startswith(PREFIXES)}
    if set(values) != expected:
        raise ValueError('Adaptation does not match configured trainable parameter set')
    with torch.no_grad():
        for name,p in model.named_parameters():
            if name in values:
                p.copy_(values[name].to(p.device))


def write_report(result, output):
    tuned=result['test_summary']['fine-tuned-land-parcel']
    unchanged=result['test_summary']['unchanged-validation-prompt']
    osm=result['test_summary']['OSM-distance-baseline']
    change='improved' if tuned['boundary_f1_mean']>unchanged['boundary_f1_mean'] else 'did not improve'
    comparison=('remained below' if tuned['boundary_f1_mean']<osm['boundary_f1_mean'] else
                'exceeded' if tuned['boundary_f1_mean']>osm['boundary_f1_mean'] else 'matched')
    conclusion=(f'This small fine-tune {change} boundary F1 versus the unchanged model and {comparison} '
        f'the OSM distance baseline. It matched {tuned["matched_instances"]} of '
        f'{tuned["reference_instances"]} parcel shapes.')
    labels={'OSM-distance-baseline':'OSM distance baseline',
        'unchanged-land-parcel':'SAM 3 before training: land parcel',
        'unchanged-validation-prompt':f'SAM 3 before training: {result["baseline_prompt"]}',
        'fine-tuned-land-parcel':'Fine-tuned SAM 3: land parcel'}
    rows = []
    for method, summary in result['test_summary'].items():
        rows.append('<tr>'+''.join(f'<td>{html.escape(str(v))}</td>' for v in [
            labels.get(method,method), summary['boundary_f1_mean'], summary['boundary_recall_mean'],
            summary['matched_instances'], summary['reference_instances'], f"{summary['coverage_mean']:.1%}",
            f"{summary['overlap_mean']:.1%}"])+'</tr>')
    tiles = list(dict.fromkeys(r['tile'] for r in result['test_details']))
    panels = ''
    for tile in tiles:
        panels += f'<section><h2>{html.escape(tile)}</h2>'
        for r in (r for r in result['test_details'] if r['tile'] == tile):
            status = ('No parcel predictions: no cyan boundaries to draw.' if not r['instances'] else
                      f'{r["instances"]} predictions · coverage {r["coverage_fraction"]:.1%} · '
                      f'boundary F1 {r["boundary_scores"]["2"]["f1"]}')
            panels += (f'<h3>{html.escape(labels.get(r["method"],r["method"]))}</h3>'
                f'<p>{html.escape(status)}</p><a href="{r["preview"]}">'
                f'<img src="{r["preview"]}" alt="Imagery, distance baseline, prediction and cadastre"></a>')
        panels += '</section>'
    text = f'''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>SAM 3 parcel fine-tuning pilot</title>
<style>body{{background:#12171e;color:#e7edf5;font:16px system-ui;margin:24px auto;padding:0 16px;max-width:1200px}}p{{line-height:1.6}}a{{color:#65deec}}img{{width:100%;max-width:1024px;height:auto}}table{{border-collapse:collapse}}td,th{{padding:10px;border-bottom:1px solid #394454;text-align:left}}.table{{overflow-x:auto}}section{{margin-top:40px}}</style>
<h1>SAM 3 parcel fine-tuning pilot</h1>
<p><strong>Result: {html.escape(conclusion)}</strong></p>
<p>{len(result['splits']['train'])} training, {len(result['splits']['validation'])} validation and {len(result['splits']['test'])} test tiles.
Geographic splits and parcel IDs are checked for leakage. Current cadastral labels are paired with 2022 RGB orthophotos;
date differences and invisible legal boundaries can make some targets impossible to infer.</p>
<p>Frozen image, text and context encoders; {result['trainable_parameters']:,} detector decoder/scoring/mask parameters trained.
This is a small supervised decoder/head pilot, not a full-model fine-tune. Training uses parcel masks and derived boxes as targets.
Inference receives only RGB features and a text prompt; no cadastral boxes or points.</p>
<p>Best epoch {result['best_epoch']} selected by validation mean boundary F1 at 2 m. Unchanged-model prompt
({html.escape(result['baseline_prompt'])}) selected on validation only. Test labels did not choose prompts, thresholds or checkpoint.
Score threshold 0.3 and mask threshold 0.5 remain fixed. Shape matching uses one-to-one IoU ≥ 0.5 on tile-clipped masks.
Boundary evaluation uses a 256×256 grid and excludes its outer three-pixel strip. Higher F1 is better.</p>
<p>Local computation; metered API charges: $0. Results from a small geographically held-out sample do not establish cross-city accuracy.</p>
<div class="table"><table><thead><tr><th>Method</th><th>Mean boundary F1</th><th>Mean boundary recall</th><th>Shape matches</th><th>Reference shapes</th><th>Mean coverage</th><th>Mean overlap</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<p><a href="results.json">Metrics and experiment recipe</a></p>
<p>Comparisons below are grouped by location. Cyan is the model prediction; pink is the cadastral reference.
An empty prediction is stated explicitly above its image.</p>{panels}</html>'''
    (output/'index.html').write_text(text)


def summarize(rows):
    return {'boundary_f1_mean':round(float(np.mean([r['boundary_scores']['2']['f1'] for r in rows])),3),
        'boundary_recall_mean':round(float(np.mean([r['boundary_scores']['2']['recall'] for r in rows])),3),
        'matched_instances':sum(r['instance_scores']['matched_instances'] for r in rows),
        'reference_instances':sum(r['instance_scores']['reference_instances'] for r in rows),
        'coverage_mean':round(float(np.mean([r['coverage_fraction'] for r in rows])),3),
        'overlap_mean':round(float(np.mean([r['overlap_fraction'] for r in rows])),3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--dataset', type=Path)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--epochs', type=int, default=4)
    parser.add_argument('--learning-rate', type=float, default=1e-5)
    parser.add_argument('--device', choices=['mps','cuda','cpu'], default='mps')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not args.run:
        parser.print_help(); return
    if not all([args.dataset,args.cache,args.output]):
        parser.error('--dataset, --cache and --output are required with --run')
    torch.set_num_threads(2)
    torch.manual_seed(SEED)
    if args.device=='mps' and not torch.backends.mps.is_available():
        raise RuntimeError('Local GPU access is required for MPS')
    output=args.output; output.mkdir(parents=True,exist_ok=True)
    samples_path=args.dataset/'samples.json'
    samples=json.loads(samples_path.read_text())
    if isinstance(samples,dict):samples=samples['samples']
    for sample in samples:
        truth=json.loads((args.dataset/sample['truth']).read_text())
        sample['source_ids']=[str(f['properties']['cestica_id']) for f in truth['features']]
    splits={s:[r for r in samples if r['split']==s] for s in ['train','validation','test']}
    if not all(splits.values()):raise ValueError('All three geographic splits required')
    from prepare_sam3_dataset import check_split_leakage
    check_split_leakage(samples)
    recipe={'dataset_sha256':hashlib.sha256(samples_path.read_bytes()).hexdigest(),
        'model_revision':REVISION,'trainable_prefixes':list(PREFIXES),'prompt':'land parcel',
        'threshold':.3,'mask_threshold':.5,'epochs':args.epochs,'learning_rate':args.learning_rate,
        'seed':SEED,'loss_resolution':128,'metered_api_usd':0,'mode':'frozen-encoders decoder-head pilot'}
    recipe_path=output/'recipe.json'
    if recipe_path.exists() and json.loads(recipe_path.read_text()) != recipe:
        raise ValueError('Existing output belongs to another experiment recipe')
    if (output/'last.pt').exists() and not args.resume:
        raise ValueError('Use --resume to continue this existing experiment')
    json_save(recipe,recipe_path)
    baseline_rows=[]
    for sample in splits['test']:
        osm_file=args.dataset/sample.get('osm_input','missing-osm.json')
        if not osm_file.exists():raise ValueError('Held-out OSM baseline input is missing')
        baseline_path=output/'osm-baseline'/f'{sample["id"]}.npz'
        baseline_path.parent.mkdir(exist_ok=True)
        if not baseline_path.exists():
            from guess import draw_polygon,draw_roads,draw_water
            from scipy.ndimage import distance_transform_edt
            data=json.loads(osm_file.read_text());seeds=np.zeros((256,256),np.int32)
            for label,feature in enumerate(data['buildings'],1):
                draw_polygon(seeds,feature['geometry'],sample['bbox'],label)
            labels=np.zeros_like(seeds)
            if seeds.any():
                nearest=distance_transform_edt(seeds==0,return_indices=True)[1]
                labels=seeds[nearest[0],nearest[1]]
                barrier=(draw_roads(data['roads'],sample['bbox'])|draw_water(data.get('water',[]),sample['bbox']))&(seeds==0)
                labels[barrier]=0
            np.savez_compressed(baseline_path,baseline=labels)
        labels=np.load(baseline_path)['baseline']
        truth=json.loads((args.dataset/sample['truth']).read_text())
        reference,edges,coverage=rasterize_reference(truth['features'],sample['bbox'])
        metrics,_=evaluate_masks([labels==i for i in np.unique(labels) if i],edges,coverage,153.6/256)
        metrics['boundary_scores']={str(t):score_boundaries(boundary(labels),edges,t/(153.6/256)) for t in [1,2,5]}
        metrics['instance_scores']=evaluate_instances([labels==i for i in np.unique(labels) if i],reference)
        metrics.update(tile=sample['id'],method='OSM-distance-baseline')
        baseline_rows.append(metrics)
    snapshot=snapshot_download('facebook/sam3',revision=REVISION,cache_dir=args.cache,local_files_only=True,
        allow_patterns=['*.json','*.txt','*.model','*.safetensors'])
    model=Sam3Model.from_pretrained(snapshot,local_files_only=True).to(args.device).eval()
    processor=Sam3Processor.from_pretrained(snapshot,local_files_only=True)
    for name,p in model.named_parameters():p.requires_grad_(name.startswith(PREFIXES))
    parameter_count=sum(p.numel() for p in model.parameters() if p.requires_grad)
    feature_dir=output/'features'; feature_dir.mkdir(exist_ok=True)
    positions_file=feature_dir/'positions.pt'
    text_file=feature_dir/'text.pt'
    feature_start=time.monotonic()
    if not text_file.exists():
        embeddings={}
        for prompt in PROMPTS:
            inputs=processor(text=prompt,return_tensors='pt').to(args.device)
            with torch.no_grad():text=model.get_text_features(inputs.input_ids,inputs.attention_mask)
            embeddings[prompt]={'pooler_output':text.pooler_output.cpu(),'attention_mask':inputs.attention_mask.cpu()}
        save(embeddings,text_file)
        del embeddings,text,inputs
    for i,sample in enumerate(samples,1):
        target=feature_dir/f'{sample["id"]}.pt'
        if target.exists() and positions_file.exists():
            log(f'Features {i}/{len(samples)} · skip cached {sample["id"]}'); continue
        image=Image.open(args.dataset/sample['image']).convert('RGB')
        inputs=processor(images=image,return_tensors='pt').to(args.device)
        with torch.no_grad():vision=model.get_vision_features(inputs.pixel_values)
        save(tuple(t.cpu() for t in vision.fpn_hidden_states),target)
        if not positions_file.exists():save(tuple(t.cpu() for t in vision.fpn_position_encoding),positions_file)
        del vision,inputs
        if args.device=='mps':torch.mps.empty_cache()
        eta=(time.monotonic()-feature_start)/i*(len(samples)-i)
        log(f'Features {i}/{len(samples)} · {sample["id"]} · ETA {eta:.0f}s')
    # Frozen encoders have no role in cached-feature training/evaluation. Release their
    # weights, rather than keeping several gigabytes beside the autograd graph.
    model.vision_encoder=None
    model.text_encoder=None
    gc.collect()
    if args.device=='mps':torch.mps.empty_cache()
    log(f'Frozen image/text encoders released; {parameter_count:,} parameters trainable')
    text_cache=torch.load(text_file,weights_only=True)
    positions=torch.load(positions_file,weights_only=True)
    initial=adaptation(model)
    baseline_file=output/'baseline-validation.json'

    def predict(sample,prompt):
        features=torch.load(feature_dir/f'{sample["id"]}.pt',weights_only=True)
        vision=Sam3VisionEncoderOutput(fpn_hidden_states=tuple(t.to(args.device) for t in features),
            fpn_position_encoding=tuple(t.to(args.device) for t in positions))
        text=BaseModelOutputWithPooling(pooler_output=text_cache[prompt]['pooler_output'].to(args.device))
        return model(vision_embeds=vision,text_embeds=text,
                     attention_mask=text_cache[prompt]['attention_mask'].to(args.device))

    def evaluate(group,prompt,method,previews=False):
        rows=[]
        model.eval()
        for i,sample in enumerate(group,1):
            with torch.no_grad():
                predictions=predict(sample,prompt)
                result=processor.post_process_instance_segmentation(predictions,threshold=.3,
                    mask_threshold=.5,target_sizes=[(256,256)])[0]
                masks=result['masks'].cpu().numpy().astype(bool)
            truth=json.loads((args.dataset/sample['truth']).read_text())
            reference,edges,coverage=rasterize_reference(truth['features'],sample['bbox'])
            metrics,pred_edges=evaluate_masks(masks,edges,coverage,153.6/256)
            metrics['instance_scores']=evaluate_instances(list(masks),reference)
            metrics.update(tile=sample['id'],method=method,prompt=prompt)
            if previews:
                slug=f'{sample["id"]}_{method}'
                folder=output/'predictions'/slug;folder.mkdir(parents=True,exist_ok=True)
                np.savez_compressed(folder/'masks.npz',masks=masks,scores=result['scores'].cpu().numpy())
                baseline_edges=np.zeros_like(edges)
                baseline_file_tile=output/'osm-baseline'/f'{sample["id"]}.npz'
                baseline_edges=boundary(np.load(baseline_file_tile)['baseline'])
                rgb=np.asarray(Image.open(args.dataset/sample['image']).convert('RGB'))
                make_comparison(rgb,baseline_edges,pred_edges,edges,folder/'comparison.png',f'{sample["id"]} · {method}')
                metrics['preview']=f'predictions/{slug}/comparison.png'
                json_save(metrics,folder/'metrics.json')
            rows.append(metrics)
            del predictions,result
            if args.device=='mps':torch.mps.empty_cache()
            log(f'{method}: {i}/{len(group)} · {sample["id"]} · F1@2m {metrics["boundary_scores"]["2"]["f1"]}')
        return rows

    if baseline_file.exists():baseline_validation=json.loads(baseline_file.read_text())
    else:
        baseline_validation={prompt:evaluate(splits['validation'],prompt,'unchanged-validation') for prompt in PROMPTS}
        json_save(baseline_validation,baseline_file)
    baseline_prompt=max(PROMPTS,key=lambda p:summarize(baseline_validation[p])['boundary_f1_mean'])
    log(f'Unchanged-model prompt selected on validation: {baseline_prompt}')
    parameters=[p for p in model.parameters() if p.requires_grad]
    optimizer=torch.optim.AdamW(parameters,lr=args.learning_rate,weight_decay=.01)
    epoch=next_index=step=0
    best_score=-1.;best_epoch=0;history=[]
    if args.resume and (output/'last.pt').exists():
        state=torch.load(output/'last.pt',weights_only=False,map_location='cpu')
        if state['recipe']!=recipe:raise ValueError('Checkpoint recipe mismatch')
        apply_adaptation(model,state['adaptation'])
        optimizer.load_state_dict(state['optimizer'])
        epoch,next_index,step=state['epoch'],state['next_index'],state['step']
        best_score,best_epoch,history=state['best_score'],state['best_epoch'],state['history']
        log(f'Resume checkpoint: {step} completed updates')
    training_start=time.monotonic();start_step=step

    def checkpoint(e,index):
        save({'recipe':recipe,'adaptation':adaptation(model),'optimizer':optimizer.state_dict(),
              'epoch':e,'next_index':index,'step':step,'best_score':best_score,
              'best_epoch':best_epoch,'history':history},output/'last.pt')

    while epoch<args.epochs:
        order=list(splits['train']);random.Random(SEED+epoch).shuffle(order)
        for index in range(next_index,len(order)):
            sample=order[index]
            targets=torch.from_numpy(np.load(args.dataset/sample['masks'])['masks']).float().to(args.device)
            optimizer.zero_grad(set_to_none=True)
            model.eval()  # deterministic pilot; frozen backbone feature cache, no dropout augmentation
            predictions=predict(sample,'land parcel')
            loss,pieces=parcel_loss(predictions,targets)
            if not torch.isfinite(loss):raise RuntimeError('Nonfinite training loss')
            loss.backward()
            gradient=torch.nn.utils.clip_grad_norm_(parameters,1.,error_if_nonfinite=True)
            optimizer.step()
            step+=1
            history.append({'step':step,'epoch':epoch+1,'tile':sample['id'],
                'loss':float(loss.detach().cpu()),'components':pieces,'gradient_norm':float(gradient.detach().cpu()),
                'metered_api_usd':0})
            del predictions,targets,loss
            if args.device=='mps':torch.mps.empty_cache()
            if step%4==0 or index+1==len(order):checkpoint(epoch,index+1)
            json_save(history,output/'training.json')
            remaining=args.epochs*len(order)-step
            eta=(time.monotonic()-training_start)/max(step-start_step,1)*remaining
            log(f'Train {step}/{args.epochs*len(order)} · loss {history[-1]["loss"]:.3f} · ETA {eta:.0f}s')
        validation=evaluate(splits['validation'],'land parcel',f'epoch-{epoch+1}-validation')
        score=summarize(validation)['boundary_f1_mean']
        json_save(validation,output/f'epoch-{epoch+1}-validation.json')
        if score>best_score:
            best_score,best_epoch=score,epoch+1
            save(adaptation(model),output/'best.pt')
            log(f'Best validation checkpoint: epoch {best_epoch}, F1 {best_score}')
        epoch+=1;next_index=0;checkpoint(epoch,0)
    trained=torch.load(output/'best.pt',weights_only=True)
    maximum_delta=max(float((trained[name]-initial[name]).abs().max()) for name in initial)
    if maximum_delta<=0:raise RuntimeError('Trained checkpoint weights did not change')
    test_details=[];test_summary={'OSM-distance-baseline':summarize(baseline_rows)}
    for method,prompt,weights in [
        ('unchanged-land-parcel','land parcel',initial),
        ('unchanged-validation-prompt',baseline_prompt,initial),
        ('fine-tuned-land-parcel','land parcel',trained)]:
        apply_adaptation(model,weights)
        rows=evaluate(splits['test'],prompt,method,previews=True)
        test_details.extend(rows);test_summary[method]=summarize(rows)
    result={**recipe,'splits':{s:[r['id'] for r in group] for s,group in splits.items()},
        'trainable_parameters':parameter_count,'baseline_prompt':baseline_prompt,'best_epoch':best_epoch,
        'best_validation_f1':best_score,'verified_maximum_parameter_change':maximum_delta,
        'test_summary':test_summary,'test_details':test_details,
        'software':{'torch':str(torch.__version__),'transformers':version('transformers')},
        'source_sha256':{name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ['sam3_finetune.py','sam3_losses.py','prepare_sam3_dataset.py']}}
    json_save(result,output/'results.json');write_report(result,output)
    log(f'Completed experiment: {test_summary}')


if __name__=='__main__':main()
