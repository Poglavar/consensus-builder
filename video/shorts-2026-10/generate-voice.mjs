#!/usr/bin/env node
// Generate scene narration and subtitle timings for the two UGT shorts.
// The key is read silently from this process environment or the adjacent emergent video/.env.
// Never print request headers, key material, or API error bodies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cacheRoot = join(here, 'audio');
const outputRoot = join(here, 'out');
const usageAuditPath = join(here, 'usage-audit.json');
const localEnv = resolve(here, '../../../emergent-rwa-solana-mobile-hackathon/video/.env');

function readApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  if (!existsSync(localEnv)) return '';
  const line = readFileSync(localEnv, 'utf8').split(/\r?\n/).find(row => row.startsWith('ELEVENLABS_API_KEY='));
  return line ? line.slice('ELEVENLABS_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '') : '';
}

const timecode = seconds => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

function sentences(text, alignment, offset) {
  const items = [];
  const re = /[^.!?:]+[.!?:]+|[^.!?:]+$/g;
  let match;
  while ((match = re.exec(text))) {
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const startIndex = match.index + lead;
    const endIndex = match.index + raw.trimEnd().length - 1;
    if (endIndex < startIndex || !alignment.character_start_times_seconds.length) continue;
    const last = alignment.character_start_times_seconds.length - 1;
    const start = offset + alignment.character_start_times_seconds[Math.min(startIndex, last)];
    const end = offset + alignment.character_end_times_seconds[Math.min(endIndex, last)] + 0.2;
    items.push({ text: raw.trim(), start, end });
  }
  return items;
}

function audioSeconds(file) {
  return Number(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
  ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
}

function cacheKey(short, scene) {
  return createHash('sha256').update(JSON.stringify([short.voice.id, short.voice.model, scene.narration])).digest('hex').slice(0, 12);
}

function readUsageAudit() {
  if (existsSync(usageAuditPath)) {
    try { return JSON.parse(readFileSync(usageAuditPath, 'utf8')); } catch {}
  }
  return {
    schemaVersion: 1,
    provider: 'ElevenLabs',
    endpoint: 'POST /v1/text-to-speech/{voice_id}/with-timestamps',
    currency: 'USD',
    costUsd: null,
    costNote: 'USD cost remains null unless provider billing data is explicitly returned; character-cost is recorded as the raw provider value and is not converted to dollars.',
    characterCountNote: 'submittedCharacters counts Unicode code points in the local request text. alignmentCharacters is the length of the provider alignment.characters array and is kept as a separate observed value.',
    responseCountNote: 'A paired cached MP3 and alignment file is one saved response artifact. It does not establish total HTTP attempts, retries, or billing events.',
    entries: [],
  };
}

function writeUsageAudit(audit) {
  const entries = audit.entries;
  const present = entries.filter(entry => entry.cacheArtifacts?.pairPresent ?? entry.cacheArtifactsPresent);
  const current = present.filter(entry => entry.versionStatus === 'current');
  const superseded = present.filter(entry => entry.versionStatus === 'superseded');
  audit.summary = {
    savedResponseArtifacts: present.length,
    currentCacheEntries: current.length,
    supersededCacheEntries: superseded.length,
    currentSubmittedCharacters: entries.filter(entry => entry.versionStatus === 'current').reduce((sum, entry) => sum + (entry.submittedCharacters ?? 0), 0),
    currentAlignmentCharacters: entries.filter(entry => entry.versionStatus === 'current').reduce((sum, entry) => sum + (entry.alignmentCharacters ?? 0), 0),
    savedAlignmentCharacters: entries.reduce((sum, entry) => sum + (entry.alignmentCharacters ?? 0), 0),
    reportedUsdCost: null,
    httpResponseRecords: audit.httpResponses.length,
  };
  const pairsPerScene = {};
  for (const entry of present) {
    const key = `${entry.filmId}/${entry.sceneId}`;
    pairsPerScene[key] = (pairsPerScene[key] ?? 0) + 1;
  }
  audit.responseCountEvidence = {
    savedResponsePairsObserved: present.length,
    currentPairs: current.length,
    supersededPairs: superseded.length,
    pairsPerScene,
    httpResponseRecordsObserved: audit.httpResponses.length,
    totalHttpAttempts: null,
    interpretation: 'Each MP3/alignment pair is one saved response artifact for a unique scene/cache key. HTTP response records are recorded when received; network failures without a response and unrecorded historical retries cannot be counted.',
  };
  writeFileSync(usageAuditPath, `${JSON.stringify(audit, null, 2)}\n`);
}

function ensureUsageAudit(short, audit) {
  const dir = join(cacheRoot, short.id);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const scene of short.scenes) {
    const activeHash = cacheKey(short, scene);
    for (const entry of audit.entries) {
      if (entry.filmId === short.id && entry.sceneId === scene.id) {
        entry.versionStatus = entry.cacheKey === activeHash ? 'current' : 'superseded';
      }
    }
    const matchingFiles = names.filter(name => name.startsWith(`${scene.id}-`) && name.endsWith('.alignment.json'));
    for (const alignmentName of matchingFiles) {
      const match = alignmentName.match(/-([a-f0-9]{12})\.alignment\.json$/);
      if (!match) continue;
      const hash = match[1];
      const alignmentPath = join(dir, alignmentName);
      const mp3Path = join(dir, `${scene.id}-${hash}.mp3`);
      let alignmentCharacters = null;
      try { alignmentCharacters = JSON.parse(readFileSync(alignmentPath, 'utf8')).characters?.length ?? null; } catch {}
      let entry = audit.entries.find(row => row.filmId === short.id && row.sceneId === scene.id && row.cacheKey === hash);
      if (!entry) {
        entry = {
          filmId: short.id,
          sceneId: scene.id,
          cacheKey: hash,
          versionStatus: hash === activeHash ? 'current' : 'superseded',
          cacheArtifacts: { audio: relative(here, mp3Path), alignment: relative(here, alignmentPath), pairPresent: existsSync(mp3Path) && existsSync(alignmentPath) },
          submittedCharacters: hash === activeHash ? [...scene.narration].length : null,
          alignmentCharacters,
          submissionTextRetained: hash === activeHash,
          providerHeaders: { requestId: null, traceId: null, characterCost: null },
          httpResponsesObserved: 0,
          usdCost: null,
          responseArtifactEvidence: 'MP3 and alignment cache pair observed; historical response headers and HTTP attempt log were not retained.',
        };
        audit.entries.push(entry);
      } else {
        entry.versionStatus = hash === activeHash ? 'current' : 'superseded';
        entry.cacheArtifacts = { audio: relative(here, mp3Path), alignment: relative(here, alignmentPath), pairPresent: existsSync(mp3Path) && existsSync(alignmentPath) };
        entry.alignmentCharacters = alignmentCharacters;
        if (hash === activeHash) {
          entry.submittedCharacters = [...scene.narration].length;
          entry.submissionTextRetained = true;
        }
      }
    }
  }
  if (!Array.isArray(audit.httpResponses)) audit.httpResponses = [];
}

function recordProviderResponse(audit, short, scene, hash, status, headers) {
  const responseRecord = {
    filmId: short.id,
    sceneId: scene.id,
    cacheKey: hash,
    observedAt: new Date().toISOString(),
    httpStatus: status,
    requestId: headers.requestId,
    traceId: headers.traceId,
    characterCost: headers.characterCost,
    usdCost: null,
  };
  audit.httpResponses.push(responseRecord);
  let entry = audit.entries.find(item => item.filmId === short.id && item.sceneId === scene.id && item.cacheKey === hash);
  if (!entry) {
    entry = {
      filmId: short.id,
      sceneId: scene.id,
      cacheKey: hash,
      versionStatus: 'current',
      cacheArtifacts: { audio: null, alignment: null, pairPresent: false },
      submittedCharacters: [...scene.narration].length,
      alignmentCharacters: null,
      submissionTextRetained: true,
      providerHeaders: { requestId: headers.requestId, traceId: headers.traceId, characterCost: headers.characterCost },
      httpResponsesObserved: 1,
      usdCost: null,
      responseArtifactEvidence: 'HTTP response observed; no validated cached audio/alignment pair is present yet.',
    };
    audit.entries.push(entry);
  } else {
    entry.providerHeaders = { requestId: headers.requestId, traceId: headers.traceId, characterCost: headers.characterCost };
    entry.httpResponsesObserved = (entry.httpResponsesObserved ?? 0) + 1;
  }
  writeUsageAudit(audit);
}

function recordSceneUsage(audit, short, scene, row) {
  const entry = audit.entries.find(item => item.filmId === short.id && item.sceneId === scene.id && item.cacheKey === row.hash);
  if (entry) {
    entry.versionStatus = 'current';
    entry.cacheArtifacts = { audio: relative(here, row.mp3), alignment: relative(here, join(dirname(row.mp3), `${scene.id}-${row.hash}.alignment.json`)), pairPresent: true };
    entry.submittedCharacters = [...scene.narration].length;
    entry.alignmentCharacters = row.alignment.characters?.length ?? null;
    entry.submissionTextRetained = true;
    if (row.providerHeaders) entry.providerHeaders = row.providerHeaders;
    entry.responseArtifactEvidence = row.cached
      ? 'Existing MP3 and alignment cache pair reused; no new provider request was made for this scene.'
      : 'MP3 and alignment written after a successful provider response and payload validation.';
  }
  writeUsageAudit(audit);
}

async function voiceScene(short, scene, key, outputDir, audit) {
  const hash = cacheKey(short, scene);
  const mp3 = join(outputDir, `${scene.id}-${hash}.mp3`);
  const alignmentFile = join(outputDir, `${scene.id}-${hash}.alignment.json`);
  if (existsSync(mp3) && existsSync(alignmentFile)) {
    const alignment = JSON.parse(readFileSync(alignmentFile, 'utf8'));
    return { mp3, alignment, seconds: audioSeconds(mp3), cached: true, hash, providerHeaders: null };
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${short.voice.id}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: scene.narration, model_id: short.voice.model, voice_settings: short.voice.settings })
  });
  const providerHeaders = {
    requestId: response.headers.get('request-id'),
    traceId: response.headers.get('x-trace-id'),
    characterCost: response.headers.get('character-cost'),
  };
  recordProviderResponse(audit, short, scene, hash, response.status, providerHeaders);
  if (!response.ok) throw new Error(`ElevenLabs returned HTTP ${response.status} for scene ${scene.id}.`);
  const body = await response.json();
  if (!body.audio_base64 || !body.alignment?.character_start_times_seconds) {
    throw new Error(`ElevenLabs response for scene ${scene.id} did not include audio and character alignment.`);
  }
  writeFileSync(mp3, Buffer.from(body.audio_base64, 'base64'));
  writeFileSync(alignmentFile, JSON.stringify(body.alignment));
  return { mp3, alignment: body.alignment, seconds: audioSeconds(mp3), cached: false, hash, providerHeaders };
}

async function build(path) {
  const short = JSON.parse(readFileSync(path, 'utf8'));
  const key = readApiKey();
  if (!key) throw new Error('ElevenLabs API key is unavailable in the process environment or configured local key file.');
  const dir = join(cacheRoot, short.id);
  mkdirSync(dir, { recursive: true });
  const usageAudit = readUsageAudit();
  ensureUsageAudit(short, usageAudit);
  writeUsageAudit(usageAudit);
  const audioRows = [];
  for (const scene of short.scenes) {
    const row = await voiceScene(short, scene, key, dir, usageAudit);
    recordSceneUsage(usageAudit, short, scene, row);
    audioRows.push(row);
    console.log(`Usage ${short.id}/${scene.id}: current script text ${[...scene.narration].length} chars; alignment ${row.alignment.characters?.length ?? 'unavailable'} chars; provider character-cost ${row.providerHeaders?.characterCost ?? 'unavailable'}; USD cost unknown${row.cached ? ' (cache hit; no new request)' : ''}.`);
  }

  let cursor = 0;
  const timeline = { id: short.id, title: short.title, format: short.format, voiceName: short.voice.name,
    targetSeconds: short.targetSeconds, disclosure: short.disclosure, wordCount: short.scenes.map(s => s.narration).join(' ').trim().split(/\s+/).length,
    scenes: [], captions: [], durationSeconds: 0 };
  const filter = [];
  audioRows.forEach((audio, index) => {
    const scene = short.scenes[index];
    const duration = audio.seconds + short.padSeconds;
    timeline.scenes.push({ id: scene.id, startSeconds: Number(cursor.toFixed(3)), audioSeconds: Number(audio.seconds.toFixed(3)),
      durationSeconds: Number(duration.toFixed(3)), narration: scene.narration, visual: scene.visual });
    timeline.captions.push(...sentences(scene.narration, audio.alignment, cursor));
    filter.push(`[${index}:a]apad=pad_dur=${short.padSeconds},atrim=duration=${duration.toFixed(3)}[a${index}]`);
    cursor += duration;
  });
  timeline.durationSeconds = Number(cursor.toFixed(3));
  timeline.captions.forEach((caption, index) => {
    if (timeline.captions[index + 1]) caption.end = Math.min(caption.end, timeline.captions[index + 1].start);
    caption.start = Number(caption.start.toFixed(3));
    caption.end = Number(Math.max(caption.start + 0.12, caption.end).toFixed(3));
  });

  const mp3Inputs = audioRows.flatMap(row => ['-i', row.mp3]);
  filter.push(`${audioRows.map((_, index) => `[a${index}]`).join('')}concat=n=${audioRows.length}:v=0:a=1[out]`);
  const finalAudio = join(outputRoot, `${short.id}-narration.mp3`);
  mkdirSync(outputRoot, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...mp3Inputs,
    '-filter_complex', filter.join(';'), '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', finalAudio],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  timeline.audioFile = relative(here, finalAudio);
  writeFileSync(join(outputRoot, `${short.id}-timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
  const srt = timeline.captions.map((caption, index) => `${index + 1}\n${timecode(caption.start)} --> ${timecode(caption.end)}\n${caption.text}\n`).join('\n');
  writeFileSync(join(outputRoot, `${short.id}.srt`), srt);
  writeFileSync(join(outputRoot, `${short.id}-transcript.md`), `# ${short.title}\n\n${short.disclosure}\n\n${short.scenes.map(scene => `## ${scene.id}\n\n${scene.narration}`).join('\n\n')}\n`);
  console.log(`${short.id}: ${timeline.wordCount} words, ${timeline.durationSeconds.toFixed(1)} seconds, ${audioRows.length} scenes, ${audioRows.filter(row => row.cached).length} reused scenes; ${finalAudio}`);
  console.log(`${short.id} usage total: ${short.scenes.reduce((sum, scene) => sum + [...scene.narration].length, 0)} current-script characters (not a billing total); USD cost unknown without provider billing data.`);
}

async function main() {
  const files = process.argv.slice(2);
  const selected = files.length ? files : ['hero1982-market-scout.json', 'jane-park-support.json'].map(name => join(here, name));
  for (const file of selected) await build(resolve(file));
}

main().catch(error => { console.error(`Narration generation failed: ${error.message}`); process.exit(1); });
