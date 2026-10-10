<script lang="ts">
  type AspectRatio = '9:16' | '16:9' | '1:1' | 'original';
  type EditPlan = {
    aspectRatio: AspectRatio;
    clips: Array<{ source: number; start: number; end: number; reason: string; punch?: boolean }>;
    captions: boolean;
    crop: 'center' | 'speaker' | 'smart';
    speed: number;
    textOverlays: Array<{ text: string; start: number; end: number; position: string; style: string; color: string }>;
    beats?: Array<{ type: 'broll' | 'motion' | 'stat' }>;
  };
  type Job = {
    id: string;
    status: 'queued' | 'analyzing' | 'directing' | 'rendering' | 'complete' | 'failed';
    progress: number;
    message: string;
    originalUrl: string;
    originalUrls: string[];
    editedUrl?: string;
    downloadUrl?: string;
    plan?: EditPlan;
    error?: string;
  };
  type ClipMeta = { duration: number };

  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:8787' : '')).replace(/\/$/, '');

  function apiUrl(value: string) {
    if (/^https?:\/\//i.test(value)) return value;
    return `${apiBaseUrl}${value.startsWith('/') ? value : `/${value}`}`;
  }

  function connectJob(next: Job): Job {
    return {
      ...next,
      originalUrl: apiUrl(next.originalUrl),
      originalUrls: next.originalUrls.map(apiUrl),
      editedUrl: next.editedUrl ? apiUrl(next.editedUrl) : undefined,
      downloadUrl: next.downloadUrl ? apiUrl(next.downloadUrl) : undefined
    };
  }

  let files = $state<File[]>([]);
  let previewUrls = $state<string[]>([]);
  let clipMeta = $state<Record<string, ClipMeta>>({});
  let selectedAspectRatio = $state<AspectRatio>('9:16');
  let soundtrack = $state(true);
  let prompt = $state('Create a sharp, polished social edit. Remove pauses and filler, keep the strongest moments, add clean captions, and make the pacing feel intentional.');
  let dragging = $state(false);
  let submitting = $state(false);
  let job = $state<Job | null>(null);
  let requestError = $state('');
  let fileInput = $state<HTMLInputElement>();
  let draggedClipIndex = $state<number | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const aspectOptions: Array<{ value: AspectRatio; label: string; hint: string }> = [
    { value: '9:16', label: 'Vertical', hint: 'Reels · TikTok' },
    { value: '16:9', label: 'Landscape', hint: 'YouTube' },
    { value: '1:1', label: 'Square', hint: 'Social feed' },
    { value: 'original', label: 'Original', hint: 'Keep source' }
  ];
  const pipelineStages = [
    { name: 'Understanding footage', detail: 'Finding speech, faces, scenes, and dead air' },
    { name: 'Directing the story', detail: 'Gemini is selecting and ordering the strongest moments' },
    { name: 'Building the cut', detail: 'Smart reframing, captions, and pacing' },
    { name: 'Finishing details', detail: 'AI visuals, soundtrack, graphics, and final export' }
  ];

  const isProcessing = $derived(job && !['complete', 'failed'].includes(job.status));
  const canSubmit = $derived(Boolean(files.length && prompt.trim() && !submitting && !isProcessing));
  const view = $derived(!job || job.status === 'failed' ? 'compose' : job.status === 'complete' ? 'result' : 'processing');
  const totalDuration = $derived(previewUrls.reduce((sum, url) => sum + (clipMeta[url]?.duration || 0), 0));
  const pipelineStage = $derived(
    !job || ['queued', 'analyzing'].includes(job.status) ? 0
      : job.status === 'directing' ? 1
        : job.status === 'rendering' && job.progress < 90 ? 2
          : job.status === 'rendering' ? 3
            : 4
  );

  function formatBytes(bytes: number) {
    return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(seconds: number) {
    if (!seconds) return '—';
    const rounded = Math.round(seconds);
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  }

  function readDuration(url: string) {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      clipMeta[url] = { duration: Number.isFinite(video.duration) ? video.duration : 0 };
      video.removeAttribute('src');
      video.load();
    };
  }

  function chooseFiles(next: File[], append = false) {
    const valid = next.filter((file) => file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name));
    if (!valid.length) {
      requestError = 'Choose an MP4, MOV, WebM, MKV, M4V, or AVI video.';
      return;
    }
    const accepted = valid.slice(0, Math.max(0, 12 - (append ? files.length : 0)));
    if (!accepted.length) return;
    if (!append) previewUrls.forEach((url) => URL.revokeObjectURL(url));
    const urls = accepted.map((file) => URL.createObjectURL(file));
    files = append ? [...files, ...accepted] : accepted;
    previewUrls = append ? [...previewUrls, ...urls] : urls;
    urls.forEach(readDuration);
    job = null;
    requestError = valid.length === next.length ? '' : 'Unsupported files were skipped.';
  }

  function removeFile(index: number) {
    const url = previewUrls[index];
    URL.revokeObjectURL(url);
    delete clipMeta[url];
    files = files.filter((_, item) => item !== index);
    previewUrls = previewUrls.filter((_, item) => item !== index);
  }

  function moveClip(from: number, to: number) {
    if (from === to || to < 0 || to >= files.length) return;
    const nextFiles = [...files];
    const nextUrls = [...previewUrls];
    const [file] = nextFiles.splice(from, 1);
    const [url] = nextUrls.splice(from, 1);
    nextFiles.splice(to, 0, file);
    nextUrls.splice(to, 0, url);
    files = nextFiles;
    previewUrls = nextUrls;
  }

  function startClipDrag(event: DragEvent, index: number) {
    event.stopPropagation();
    draggedClipIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
    }
  }

  function dropClip(event: DragEvent, index: number) {
    event.preventDefault();
    event.stopPropagation();
    if (draggedClipIndex !== null) moveClip(draggedClipIndex, index);
    draggedClipIndex = null;
  }

  function reorderWithKeyboard(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    moveClip(index, index + (event.key === 'ArrowLeft' ? -1 : 1));
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    chooseFiles(Array.from(event.dataTransfer?.files || []), files.length > 0);
  }

  async function readError(response: Response) {
    try {
      const body = await response.json() as { error?: string };
      return body.error || `Request failed (${response.status})`;
    } catch {
      return `Request failed (${response.status})`;
    }
  }

  async function pollJob(id: string) {
    try {
      const response = await fetch(apiUrl(`/api/edits/${id}`));
      if (!response.ok) throw new Error(await readError(response));
      job = connectJob(await response.json() as Job);
      if (!['complete', 'failed'].includes(job.status)) pollTimer = setTimeout(() => pollJob(id), 1400);
    } catch (error) {
      requestError = error instanceof Error ? error.message : 'Could not read render status.';
    }
  }

  async function submit() {
    if (!canSubmit) return;
    submitting = true;
    requestError = '';
    const body = new FormData();
    files.forEach((file) => body.append('videos', file));
    body.append('prompt', prompt.trim());
    body.append('aspectRatio', selectedAspectRatio);
    body.append('visualMode', 'generated');
    body.append('soundtrack', String(soundtrack));
    try {
      const response = await fetch(apiUrl('/api/edits'), { method: 'POST', body });
      if (!response.ok) throw new Error(await readError(response));
      job = connectJob(await response.json() as Job);
      await pollJob(job.id);
    } catch (error) {
      requestError = error instanceof Error ? error.message : 'The edit could not be started.';
    } finally {
      submitting = false;
    }
  }

  function reset() {
    if (pollTimer) clearTimeout(pollTimer);
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    files = [];
    previewUrls = [];
    clipMeta = {};
    job = null;
    requestError = '';
    if (fileInput) fileInput.value = '';
  }
</script>

<svelte:head>
  <title>Motify — AI Video Editor</title>
  <meta name="description" content="Turn raw footage into polished social video with an AI editor." />
</svelte:head>

{#snippet icon(name: 'create' | 'sparkles' | 'music' | 'library' | 'settings')}
  {#if name === 'create'}
    <svg viewBox="0 0 24 24"><path d="M4 7.5A3.5 3.5 0 0 1 7.5 4h5M4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5v-5M14 4h6v6m0-6-9 9" /></svg>
  {:else if name === 'sparkles'}
    <svg viewBox="0 0 24 24"><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3ZM5.5 14l.8 2.2 2.2.8-2.2.8L5.5 20l-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM18 13l.8 2.2 2.2.8-2.2.8L18 19l-.8-2.2-2.2-.8 2.2-.8L18 13Z" /></svg>
  {:else if name === 'music'}
    <svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13M9 9l10-2M6.5 21C8 21 9 20.1 9 19s-1-2-2.5-2S4 17.9 4 19s1 2 2.5 2Zm10-2c1.5 0 2.5-.9 2.5-2s-1-2-2.5-2-2.5.9-2.5 2 1 2 2.5 2Z" /></svg>
  {:else if name === 'library'}
    <svg viewBox="0 0 24 24"><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 0v16m5-16v16" /></svg>
  {:else}
    <svg viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>
  {/if}
{/snippet}

<div class="app-shell">
  <aside class="rail">
    <a class="logo" href="/" aria-label="Motify home"><picture><source media="(max-width: 760px)" srcset="/motify-mark-white.png" /><img src="/motify-wordmark-white.png" alt="Motify" /></picture></a>
    <nav aria-label="Primary navigation">
      <button class="nav-item active" type="button">{@render icon('create')}<span>Create</span></button>
      <button class="nav-item" type="button">{@render icon('library')}<span>My edits</span><span class="soon">Soon</span></button>
    </nav>
    <div class="nav-label">AI tools</div>
    <div class="tool-list">
      <div class="tool-item">{@render icon('sparkles')}<div><strong>AI visuals</strong><small>Nano Banana Pro</small></div></div>
      <div class="tool-item">{@render icon('music')}<div><strong>Soundtrack</strong><small>Lyria 3</small></div></div>
    </div>
    <div class="rail-spacer"></div>
    <button class="nav-item settings-link" type="button">{@render icon('settings')}<span>Settings</span></button>
  </aside>

  <main class="workspace">
    <div class="ambient" aria-hidden="true"></div>
    {#if view === 'compose'}
      <section class="create-view">
        <header class="hero-copy">
          <h1>What are we making today?</h1>
          <p>Drop in your footage. Motify finds the story, cleans the cut, and finishes it with visuals, captions, and sound.</p>
        </header>

        <div class="creator-card">
          <section class="source-panel">
            <div class="section-heading">
              <div><span class="step-number">1</span><div><strong>Add your footage</strong><small>Up to 12 clips · 4 GB each</small></div></div>
              {#if files.length}<button class="text-button" type="button" onclick={() => fileInput?.click()}>+ Add clip</button>{/if}
            </div>
            <div class="drop-area" class:dragging class:has-files={files.length > 0} role="button" tabindex="0"
              ondragover={(event) => { event.preventDefault(); dragging = true; }} ondragleave={() => dragging = false} ondrop={onDrop}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput?.click(); }} onclick={() => { if (!files.length) fileInput?.click(); }}>
              {#if !files.length}
                <span class="upload-glyph"><svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v3.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V14" /></svg></span>
                <strong>Drop videos here</strong><span>or click to browse your files</span><small>MP4, MOV, WebM, MKV, M4V or AVI</small>
              {:else}
                <div class="file-list-heading">
                  <span>Clip order</span>
                  <small>Drag cards left or right to reorder</small>
                </div>
                <div class="file-list">
                  {#each files as file, index}
                    <div
                      class="file-card"
                      class:clip-dragging={draggedClipIndex === index}
                      class:clip-drop-target={draggedClipIndex !== null && draggedClipIndex !== index}
                      draggable="true"
                      role="button"
                      tabindex="0"
                      aria-label={`Clip ${index + 1}: ${file.name}. Drag to reorder, or use left and right arrow keys.`}
                      ondragstart={(event) => startClipDrag(event, index)}
                      ondragend={() => draggedClipIndex = null}
                      ondragover={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      ondrop={(event) => dropClip(event, index)}
                      onkeydown={(event) => reorderWithKeyboard(event, index)}
                    >
                      <div class="file-preview">
                        <video src={previewUrls[index]} muted playsinline preload="metadata"></video>
                        <span class="clip-number">{index + 1}</span>
                        <span class="drag-grip" aria-hidden="true"><i></i><i></i><i></i></span>
                        <button type="button" class="remove-button" aria-label={`Remove ${file.name}`} onclick={(event) => { event.stopPropagation(); removeFile(index); }}><svg viewBox="0 0 16 16"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
                      </div>
                      <div class="file-copy"><strong>{file.name}</strong><small>{formatDuration(clipMeta[previewUrls[index]]?.duration)} · {formatBytes(file.size)}</small></div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </section>

          <section class="direction-panel">
            <div class="section-heading"><div><span class="step-number">2</span><div><strong>Direct the edit</strong><small>Say what you want in plain language</small></div></div><span class="character-count">{prompt.length}/2000</span></div>
            <div class="prompt-box"><span class="prompt-spark">{@render icon('sparkles')}</span><textarea bind:value={prompt} maxlength="2000" placeholder="Make a polished 30-second social edit…"></textarea></div>
          </section>

          <section class="finish-panel">
            <div class="section-heading"><div><span class="step-number">3</span><div><strong>Choose the finish</strong><small>Motify handles the technical details</small></div></div></div>
            <div class="finish-grid">
              <div class="control-card format-card"><span class="control-label">Format</span><div class="segmented" role="radiogroup" aria-label="Output format">
                {#each aspectOptions as option}<button type="button" class:active={selectedAspectRatio === option.value} onclick={() => selectedAspectRatio = option.value} aria-label={`${option.label}: ${option.hint}`}><strong>{option.value === 'original' ? 'Original' : option.value}</strong><small>{option.label}</small></button>{/each}
              </div></div>
              <div class="control-card visuals-card"><span class="control-label">Supporting visuals</span><div class="visual-engine" aria-label="Nano Banana Pro supporting visuals enabled">
                <span class="visual-engine-mark">{@render icon('sparkles')}</span>
                <span><strong>Nano Banana Pro</strong><small>Sparse AI B-roll and supporting graphics</small></span>
                <span class="engine-status"><i></i>On</span>
              </div></div>
              <button class="control-card soundtrack-card" class:active={soundtrack} type="button" role="switch" aria-checked={soundtrack} onclick={() => soundtrack = !soundtrack}><span class="sound-icon">{@render icon('music')}</span><span><strong>Generated soundtrack</strong><small>Original instrumental bed by Lyria 3</small></span><span class="toggle"><i></i></span></button>
            </div>
          </section>

          {#if requestError || job?.error}<div class="error" role="alert">{requestError || job?.error}</div>{/if}
          <footer class="creator-footer"><span>{files.length ? `${files.length} clip${files.length === 1 ? '' : 's'} · ${formatDuration(totalDuration)} source` : 'Add footage to begin'}</span><button class="generate-button" type="button" disabled={!canSubmit} onclick={submit}><span class="button-spark">{@render icon('sparkles')}</span>{submitting ? 'Uploading footage…' : 'Generate edit'}<svg class="arrow" viewBox="0 0 20 20"><path d="M4 10h12m-5-5 5 5-5 5" /></svg></button></footer>
        </div>
      </section>
    {:else if job && view === 'processing'}
      <section class="process-view"><div class="process-layout">
        <div class="preview-card"><video src={previewUrls[0] || job.originalUrls?.[0] || job.originalUrl} muted autoplay loop playsinline></video><div class="preview-shade"></div><div class="progress-orb" style={`--progress: ${job.progress * 3.6}deg`}><span>{job.progress}<small>%</small></span></div><span class="working-pill"><i></i> Motify is editing</span></div>
        <aside class="process-card"><span class="eyebrow"><i></i> AI edit in progress</span><h2>Building your first cut</h2><p>{job.message || pipelineStages[Math.min(pipelineStage, 3)].detail}</p>
          <div class="stage-list">{#each pipelineStages as stage, index}<div class="stage" class:active={index === pipelineStage} class:done={index < pipelineStage}><span>{index < pipelineStage ? '✓' : index + 1}</span><div><strong>{stage.name}</strong><small>{stage.detail}</small></div></div>{/each}</div>
          <div class="progress-line"><span style={`width:${job.progress}%`}></span></div><small class="patience">You can leave this tab open while Motify finishes.</small>
        </aside>
      </div></section>
    {:else if job}
      <section class="result-view">
        <header class="result-heading"><div><span class="success-mark">✓</span><div><span class="eyebrow">Edit complete</span><h1>Your video is ready.</h1></div></div><button class="secondary-button" type="button" onclick={reset}>New edit</button></header>
        <div class="result-layout"><div class="result-preview">
          <!-- svelte-ignore a11y_media_has_caption: requested captions are burned into the rendered video -->
          <video src={job.editedUrl} controls autoplay playsinline preload="metadata"></video>
        </div>
          <aside class="result-card"><img src="/motify-mark-white.png" alt="" class="result-mark" /><span class="result-kicker">Motify final cut</span><h2>Polished and ready to publish</h2><p>Your edit includes the selected story, smart reframing, captions, supporting visual beats, and final audio polish.</p>
            {#if job.plan}<dl class="result-facts"><div><dt>Format</dt><dd>{job.plan.aspectRatio}</dd></div><div><dt>Cuts</dt><dd>{job.plan.clips.length}</dd></div><div><dt>Visual beats</dt><dd>{job.plan.beats?.length || 0}</dd></div><div><dt>Captions</dt><dd>{job.plan.captions ? 'Added' : 'Off'}</dd></div></dl>{/if}
            <a class="download-button" href={job.downloadUrl} download><svg viewBox="0 0 20 20"><path d="M10 3v10m0 0 4-4m-4 4L6 9M3 16h14" /></svg>Download MP4</a><button class="secondary-button full" type="button" onclick={reset}>Create another edit</button>
          </aside>
        </div>
      </section>
    {/if}
  </main>
  <input class="visually-hidden" bind:this={fileInput} type="file" multiple accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*" onchange={(event) => { chooseFiles(Array.from(event.currentTarget.files || []), files.length > 0); event.currentTarget.value = ''; }} />
</div>
