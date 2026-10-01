<script lang="ts">
  type EditPlan = {
    aspectRatio: '9:16' | '16:9' | '1:1' | 'original';
    clips: Array<{ source: number; start: number; end: number; reason: string; punch?: boolean }>;
    captions: boolean;
    crop: 'center' | 'speaker' | 'smart';
    speed: number;
    textOverlays: Array<{
      text: string;
      start: number;
      end: number;
      position: 'top' | 'center' | 'bottom';
      style: 'title' | 'keyword' | 'lowerThird';
      color: 'white' | 'lime' | 'pink' | 'yellow';
    }>;
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

  let files = $state<File[]>([]);
  let previewUrls = $state<string[]>([]);
  let selectedAspectRatio = $state<'9:16' | '16:9' | '1:1' | 'original'>('9:16');
  let prompt = $state('Make this into a fast 30-second TikTok. Remove pauses and silences, keep the strongest points, add captions, and make the pacing energetic.');
  let dragging = $state(false);
  let submitting = $state(false);
  let job = $state<Job | null>(null);
  let requestError = $state('');
  let fileInput = $state<HTMLInputElement>();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const presets = [
    { title: 'Fast TikTok (30s)', text: 'Make this into a fast 30-second TikTok. Cut out pauses and filler words, center speaker, add burned captions, and keep the energy high.' },
    { title: 'Story Cut (Sequential)', text: 'Combine clips sequentially into a coherent story arc. Cut dead air, zoom punch-in on key statements, and add subtle title hooks.' },
    { title: 'Clean Speech Focus', text: 'Remove all hesitation and silence, normalize voice loudness, keep the best takes, and burn clear subtitle captions.' }
  ];

  const isProcessing = $derived(job && !['complete', 'failed'].includes(job.status));
  const canSubmit = $derived(Boolean(files.length && prompt.trim() && !submitting && !isProcessing));
  const statusIndex = $derived(
    job ? Math.max(0, ['queued', 'analyzing', 'directing', 'rendering', 'complete'].indexOf(job.status)) : -1
  );

  function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function chooseFiles(next: File[], append = false) {
    if (!next.length) return;
    const valid = next.filter((file) => file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name));
    if (valid.length !== next.length) {
      requestError = 'Only supported video files were added.';
      if (!valid.length) return;
    }
    const room = Math.max(0, 12 - (append ? files.length : 0));
    const accepted = valid.slice(0, room);
    if (!accepted.length) {
      requestError = 'This prototype supports up to 12 source clips.';
      return;
    }
    if (!append) previewUrls.forEach((url) => URL.revokeObjectURL(url));
    files = append ? [...files, ...accepted] : accepted;
    previewUrls = append
      ? [...previewUrls, ...accepted.map((file) => URL.createObjectURL(file))]
      : accepted.map((file) => URL.createObjectURL(file));
    job = null;
    if (valid.length === next.length) requestError = '';
    if (pollTimer) clearTimeout(pollTimer);
  }

  function removeFile(index: number) {
    URL.revokeObjectURL(previewUrls[index]);
    files = files.filter((_, i) => i !== index);
    previewUrls = previewUrls.filter((_, i) => i !== index);
  }

  function moveClip(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= files.length || fromIndex === toIndex) return;
    const nextFiles = [...files];
    const nextUrls = [...previewUrls];
    const [movedFile] = nextFiles.splice(fromIndex, 1);
    const [movedUrl] = nextUrls.splice(fromIndex, 1);
    nextFiles.splice(toIndex, 0, movedFile);
    nextUrls.splice(toIndex, 0, movedUrl);
    files = nextFiles;
    previewUrls = nextUrls;
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    chooseFiles(Array.from(event.dataTransfer?.files || []), files.length > 0);
  }

  async function readError(response: Response) {
    try {
      const body = (await response.json()) as { error?: string };
      return body.error || `Request failed (${response.status})`;
    } catch {
      return `Request failed (${response.status})`;
    }
  }

  async function pollJob(id: string) {
    try {
      const response = await fetch(`/api/edits/${id}`);
      if (!response.ok) throw new Error(await readError(response));
      job = (await response.json()) as Job;
      if (!['complete', 'failed'].includes(job.status)) {
        pollTimer = setTimeout(() => pollJob(id), 1400);
      }
    } catch (error) {
      requestError = error instanceof Error ? error.message : 'Could not read render status.';
    }
  }

  async function submit() {
    if (!files.length || !canSubmit) return;
    submitting = true;
    requestError = '';

    const body = new FormData();
    files.forEach((file) => body.append('videos', file));
    body.append('prompt', prompt.trim());
    body.append('aspectRatio', selectedAspectRatio);

    try {
      const response = await fetch('/api/edits', { method: 'POST', body });
      if (!response.ok) throw new Error(await readError(response));
      job = (await response.json()) as Job;
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
    job = null;
    requestError = '';
    if (fileInput) fileInput.value = '';
  }
</script>

<svelte:head>
  <title>Motify Clip — Autonomous Video Director</title>
</svelte:head>

<header class="topbar">
  <div class="brand-group">
    <a class="brand" href="/" aria-label="Motify home">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="brand-name">motify</span>
    </a>
    <span class="brand-sep">/</span>
    <span class="brand-product">clip</span>
  </div>
</header>

<main>
  <section class="intro">
    <h1>Describe the edit.<br /><em>We’ll find the story.</em></h1>
    <p class="lede">Drop in one or multiple clips, reorder your story, and Motify combines them into a finished cut.</p>
  </section>

  {#if !job || job.status === 'failed'}
    <section class="workspace" aria-label="Create an edit">
      <div class="step-label">
        <span>01</span> Footage
        {#if files.length > 1}
          <span class="reorder-hint-note">Use <strong>◀ ▶</strong> arrows to reorder chronological story</span>
        {/if}
      </div>

      {#if !files.length}
        <button
          class:dragging
          class="dropzone"
          type="button"
          ondragover={(event) => { event.preventDefault(); dragging = true; }}
          ondragleave={() => dragging = false}
          ondrop={onDrop}
          onclick={() => fileInput?.click()}
        >
          <span class="upload-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <path d="M24 32V12m0 0-7 7m7-7 7 7M10 30v5a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3v-5" />
            </svg>
          </span>
          <strong>Drop videos here</strong>
          <small>or click to browse · up to 12 source clips</small>
        </button>
      {:else}
        <div class="source-grid">
          {#each files as file, index}
            <div class="source-card">
              <div class="source-card-header">
                <span class="source-number">Source #{index + 1}</span>
                <div class="source-reorder-pills">
                  <button
                    type="button"
                    class="source-reorder-btn"
                    disabled={index === 0}
                    onclick={() => moveClip(index, index - 1)}
                    title="Move clip earlier"
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    class="source-reorder-btn"
                    disabled={index === files.length - 1}
                    onclick={() => moveClip(index, index + 1)}
                    title="Move clip later"
                  >
                    ▶
                  </button>
                </div>
              </div>
              <!-- svelte-ignore a11y_media_has_caption: user-supplied local footage has no caption track -->
              <video src={previewUrls[index]} controls playsinline preload="metadata"></video>
              <div class="file-meta">
                <div>
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                </div>
                <button
                  type="button"
                  class="remove-clip-btn"
                  onclick={() => removeFile(index)}
                  aria-label={`Remove ${file.name}`}
                  title="Remove clip"
                >
                  ×
                </button>
              </div>
            </div>
          {/each}
          {#if files.length < 12}
            <button class="add-source" type="button" onclick={() => fileInput?.click()}>
              <span>+</span>Add another clip
            </button>
          {/if}
        </div>
      {/if}

      <input
        class="visually-hidden"
        bind:this={fileInput}
        type="file"
        multiple
        accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/*"
        onchange={(event) => {
          chooseFiles(Array.from(event.currentTarget.files || []), files.length > 0);
          event.currentTarget.value = '';
        }}
      />

      <div class="divider"></div>

      <div class="step-label"><span>02</span> Direction & Framing</div>

      <!-- Target Aspect Ratio Picker -->
      <div class="aspect-choice-row">
        <span class="aspect-choice-label">Aspect:</span>
        <button
          type="button"
          class="aspect-chip"
          class:active={selectedAspectRatio === '9:16'}
          onclick={() => selectedAspectRatio = '9:16'}
        >
          <svg class="aspect-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          </svg>
          <span>9:16 Vertical (TikTok/Reels)</span>
        </button>
        <button
          type="button"
          class="aspect-chip"
          class:active={selectedAspectRatio === '16:9'}
          onclick={() => selectedAspectRatio = '16:9'}
        >
          <svg class="aspect-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          </svg>
          <span>16:9 Landscape (YouTube)</span>
        </button>
        <button
          type="button"
          class="aspect-chip"
          class:active={selectedAspectRatio === '1:1'}
          onclick={() => selectedAspectRatio = '1:1'}
        >
          <svg class="aspect-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          </svg>
          <span>1:1 Square (Feed)</span>
        </button>
        <button
          type="button"
          class="aspect-chip"
          class:active={selectedAspectRatio === 'original'}
          onclick={() => selectedAspectRatio = 'original'}
        >
          <svg class="aspect-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2.5 1.5"/>
          </svg>
          <span>Original Ratio</span>
        </button>
      </div>

      <label class="prompt-field">
        <span>What do you want to make?</span>
        <textarea
          bind:value={prompt}
          rows="4"
          maxlength="2000"
          placeholder="Turn this into a sharp 30-second social cut…"
        ></textarea>
        <small>{prompt.length} / 2000</small>
      </label>

      <div class="presets-chips-row">
        <span class="presets-chips-label">Presets:</span>
        {#each presets as preset}
          <button
            type="button"
            class="preset-chip-btn"
            onclick={() => prompt = preset.text}
          >
            {preset.title}
          </button>
        {/each}
      </div>

      {#if requestError || job?.error}
        <div class="error" role="alert">{requestError || job?.error}</div>
      {/if}

      <button class="edit-button" type="button" disabled={!canSubmit} onclick={submit}>
        <span>{submitting ? 'Uploading footage…' : isProcessing ? 'Directing…' : files.length > 1 ? `Combine & Edit (${files.length} Clips)` : 'Generate Cut'}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" /></svg>
      </button>
    </section>
  {:else if job.status !== 'complete'}
    <section class="processing" aria-live="polite">
      <div class="processing-preview">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={job.originalUrls?.[0] || job.originalUrl} muted autoplay loop playsinline></video>
        <div class="scanline"></div>
        <div class="timecode">AI DIRECTING · {job.progress}%</div>
      </div>
      <div class="processing-copy">
        <p class="eyebrow">Building your edit</p>
        <h2>{job.message}</h2>
        <div class="progress-track"><span style={`width: ${job.progress}%`}></span></div>
        <p class="progress-value">{job.progress}%</p>
        <ol class="stages">
          {#each ['Analyze footage & silence intervals', 'Gemini curates story arc', 'Dynamic cuts & smart framing', 'Render with FFmpeg'] as stage, index}
            <li class:active={index === statusIndex - 1 || (statusIndex === 0 && index === 0)} class:done={index < statusIndex - 1}>
              <span>{index < statusIndex - 1 ? '✓' : index + 1}</span>{stage}
            </li>
          {/each}
        </ol>
        {#if requestError}<div class="error" role="alert">{requestError}</div>{/if}
      </div>
    </section>
  {:else}
    <section class="result">
      <div class="result-heading">
        <div>
          <p class="eyebrow">Your finished cut is ready</p>
          <h2>Original, reimagined.</h2>
        </div>
        <button class="secondary-button" type="button" onclick={reset}>Make another edit</button>
      </div>

      <div class="comparison">
        <article>
          <div class="video-label">
            <span>Sources</span>
            <small>{job.originalUrls.length} raw clip{job.originalUrls.length === 1 ? '' : 's'}</small>
          </div>
          <div class="original-stack">
            {#each job.originalUrls as originalUrl, index}
              <div>
                <small>Source #{index + 1}</small>
                <!-- svelte-ignore a11y_media_has_caption: user-supplied local footage has no caption track -->
                <video src={originalUrl} controls playsinline preload="metadata"></video>
              </div>
            {/each}
          </div>
        </article>
        <article class="edited">
          <div class="video-label">
            <span>Edited Cut</span>
            <small>{job.plan?.aspectRatio || '9:16'} · Motify</small>
          </div>
          <!-- svelte-ignore a11y_media_has_caption: captions, when requested, are burned into the video -->
          <video src={job.editedUrl} controls autoplay playsinline preload="metadata"></video>
        </article>
      </div>

      <div class="result-actions">
        <a class="download-button" href={job.downloadUrl} download>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m0 0 4-4m-4 4L6 9M3 16h14" /></svg>
          Download edited video (MP4)
        </a>
      </div>

      {#if job.plan}
        <details class="plan-panel" open>
          <summary>
            <span><i></i> Gemini edit plan</span>
            <small>debug JSON</small>
          </summary>
          <pre>{JSON.stringify(job.plan, null, 2)}</pre>
        </details>
      {/if}
    </section>
  {/if}

  <footer>
    <div class="footer-brand">
      <span class="brand-mark"><i></i><i></i><i></i></span>
      <span>motify / clip</span>
    </div>
  </footer>
</main>
