import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { FIELD_PHOTO_LIMIT, canRetryFieldPhotoPrediction, FieldPhotoCoverage, FieldPhotoGallery, FieldPhotoPrediction, type FieldPhoto } from '@harvest/contracts';
import { apiRequest, jsonInit, newEntryId } from '../../features/photo-region/http';
import { formatDay } from './model';
import { AiSparkIcon } from '../ui/AiSpark';
import { PhotoCoverage } from './PhotoCoverage';
import './field-image.css';

interface Draft { mediaId: string; name: string; date: string; exif: boolean; imagePath: string }
export const fieldPhotoPath = (farmId: string, cycleId: string) => `/api/v1/farms/${encodeURIComponent(farmId)}/cycles/${encodeURIComponent(cycleId)}/field-photos`;
export function photoAt(photos: FieldPhoto[], date: string): FieldPhoto | null {
  return [...photos].filter(p => p.capturedOn <= date).sort((a, b) => b.capturedOn.localeCompare(a.capturedOn) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
const safeImage = (path: string | null) => path && /^\/api\/v1\/(media|farms)\//.test(path) && !path.includes('\\') && !path.includes('//') ? path : undefined;
const failureText = (reason: string | null) => reason === 'image_did_not_progress' ? 'The generated image did not show enough crop development, so it was rejected. You can retry.' : reason === 'image_framing_changed' ? 'The generated image changed the framing, so it was rejected. You can retry.' : reason === 'budget_exceeded' ? 'Today’s AI budget is used up. Try another day.' : reason === 'photo_changed' ? 'The photo date changed. Create a new prediction from the corrected date.' : 'This prediction could not be completed. Your original photo is still available.';

/** Keyed by owner session + farm + crop in TodayView: pending requests can never write into another field's gallery. */
export function FieldImage(props: {farmId: string; cycleId: string; date: string; today: string; fieldName: string | null; onGalleryChange?: (farmId: string, cycleId: string, gallery: FieldPhotoGallery) => void}) {
  const base = fieldPhotoPath(props.farmId, props.cycleId);
  const [gallery, setGallery] = createSignal<FieldPhotoGallery>({photos: [], predictions: []});
  const [loading, setLoading] = createSignal(true);
  createEffect(() => { if (!loading()) props.onGalleryChange?.(props.farmId, props.cycleId, gallery()); });
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [drafts, setDrafts] = createSignal<Draft[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [original, setOriginal] = createSignal(false);
  const [imageError, setImageError] = createSignal<string | undefined>();
  /** Envelope mode of the last gallery response: a live server may retry an old `provider_unavailable` measurement (F7). */
  const [live, setLive] = createSignal(false);
  let alive = true, input: HTMLInputElement | undefined, timer: ReturnType<typeof setTimeout> | undefined, polls = 0;
  onCleanup(() => { alive = false; clearTimeout(timer); });
  async function refresh() {
    const envelope = await apiRequest(base);
    const result = FieldPhotoGallery.parse(envelope.data);
    if (alive) { setGallery(result); setLive(envelope.mode === 'live'); setLoading(false); }
  }
  onMount(() => { void refresh().catch(e => { if (alive) { setMessage(e.message); setLoading(false); } }); });
  createEffect(() => {
    props.date; setSelected(null); setOriginal(false);
  });
  const allPhotos = () => [...gallery().photos, ...(gallery().observations ?? [])];
  const photo = createMemo(() => allPhotos().find(p => p.id === selected()) ?? photoAt(allPhotos(), props.date) ?? allPhotos()[0] ?? null);
  const prediction = createMemo(() => gallery().predictions.filter(p => p.photoId === photo()?.id && p.sourceDate === photo()?.capturedOn && p.targetDate === props.date).sort((a, b) => Number(!!a.outdated) - Number(!!b.outdated) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null);
  const expected = createMemo(() => gallery().predictions.filter(p => p.status === 'ready' && p.imagePath && p.targetDate === photo()?.capturedOn && p.sourceDate < photo()!.capturedOn)
    .sort((a,b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))[0] ?? null);
  const priorExpectation = () => !!expected()?.createdAt && expected()!.createdAt! < photo()!.createdAt;
  const pending = () => prediction()?.status === 'queued' || prediction()?.status === 'running';
  const showPrediction = () => prediction()?.status === 'ready' && !original();
  const src = () => safeImage(showPrediction() ? prediction()!.imagePath : photo()?.imagePath ?? null);
  const dateAllowed = () => !!photo() && props.date > photo()!.capturedOn;
  const maxDate = () => new Date(Date.parse(`${props.today}T00:00:00Z`) + 120 * 86400000).toISOString().slice(0, 10);
  createEffect(() => {
    clearTimeout(timer);
    const coveragePending = allPhotos().some(p => p.coverage?.status === 'queued' || p.coverage?.status === 'running');
    const predictionPending = gallery().predictions.some(p => p.status === 'queued' || p.status === 'running');
    if (polls >= 5 && !coveragePending && !predictionPending) return;
    // F7: say which job is slow; coverage alone must not be reported as a prediction.
    if (polls >= 60) { setMessage(predictionPending ? 'The prediction is taking longer than usual. Refresh photos to check its progress.' : 'Measuring the photo is taking longer than usual. Refresh photos to check its progress.'); return; }
    timer = setTimeout(() => { polls++; void refresh().catch(e => { if (alive) setMessage(e.message); }); }, 3000);
  });
  async function upload(files: File[]) {
    if (busy() || !files.length) return;
    setMessage('');
    if (files.length + gallery().photos.length + drafts().length > FIELD_PHOTO_LIMIT) { setMessage('You can upload up to 6 photos. Choose fewer photos or remove an existing one.'); return; }
    if (files.some(f => !['image/jpeg', 'image/png', 'image/webp'].includes(f.type))) { setMessage('Choose JPEG, PNG or WebP photos. Export HEIC photos as JPEG first.'); return; }
    setBusy(true);
    try {
      for (const file of files) {
        if (!alive) break;
        const form = new FormData(); form.append('file', file);
        const data = (await apiRequest<{id: string; contentPath: string; exifCreatedAt?: string | null}>(`/api/v1/media?farmId=${encodeURIComponent(props.farmId)}`, {method: 'POST', body: form, headers: {'idempotency-key': newEntryId('field-photo')}})).data;
        if (!data || !alive) break;
        const exif = !!data.exifCreatedAt && data.exifCreatedAt <= props.today;
        setDrafts(previous => [...previous, {mediaId: data.id, name: file.name, date: exif ? data.exifCreatedAt! : props.today, exif, imagePath: data.contentPath}]);
      }
    } catch (e) { if (alive) setMessage((e as Error).message); }
    finally { if (alive) setBusy(false); }
  }
  async function save() {
    if (busy() || drafts().some(d => !d.date || d.date > props.today)) return;
    setBusy(true); setMessage('');
    try {
      const result = FieldPhotoGallery.parse((await apiRequest(base, jsonInit('POST', {photos: drafts().map(d => ({mediaId: d.mediaId, capturedOn: d.date}))}))).data);
      if (alive) { polls = 0; setGallery(result); setDrafts([]); setSelected(null); }
    } catch (e) { if (alive) setMessage((e as Error).message); }
    finally { if (alive) setBusy(false); }
  }
  async function remove(p: FieldPhoto) {
    if (busy()) return;
    setBusy(true); setMessage('');
    try {
      const result = FieldPhotoGallery.parse((await apiRequest(`${base}/${p.id}`, {method: 'DELETE'})).data);
      if (alive) { setGallery(result); setSelected(null); }
    } catch (e) { if (alive) setMessage((e as Error).message); }
    finally { if (alive) setBusy(false); }
  }
  async function measure(p: FieldPhoto) {
    if (busy()) return;
    setBusy(true); setMessage('');
    try {
      const envelope = await apiRequest(`${base}/${p.id}/coverage`, jsonInit('POST', {regenerate: true}));
      const coverage = FieldPhotoCoverage.parse(envelope.data);
      if (alive) setLive(envelope.mode === 'live');
      const put = (list: FieldPhoto[] | undefined) => list?.map(x => x.id === p.id ? {...x, coverage} : x);
      if (alive) { polls = 0; setGallery(g => ({...g, photos: put(g.photos)!, ...(g.observations ? {observations: put(g.observations)} : {})})); }
    } catch (e) { if (alive) setMessage((e as Error).message); }
    finally { if (alive) setBusy(false); }
  }
  async function predict() {
    const source = photo(), targetDate = props.date;
    if (!source || busy() || !dateAllowed() || pending()) return;
    setBusy(true); setMessage('');
    try {
      const result = FieldPhotoPrediction.parse((await apiRequest(`${base}/${source.id}/predict`, jsonInit('POST', {targetDate}))).data);
      if (alive) { polls = 0; setOriginal(false); setGallery(g => ({...g, predictions: [...g.predictions.filter(p => p.id !== result.id), result]})); }
    } catch (e) { if (alive) setMessage((e as Error).message); }
    finally { if (alive) setBusy(false); }
  }
  return <div class="field-images" data-testid="field-images" aria-busy={loading() || busy()}>
    <Show when={!loading()} fallback={<p role="status">Loading field photos…</p>}>
      <Show when={photo()} fallback={<div class="field-images-empty"><span class="field-images-eyebrow">Your field, through the season</span><h3>Add your field photos</h3><p>Upload 1–6 photos of {props.fieldName ?? 'your field'}. Confirm when each was taken, then move the season slider to preview crop growth with AI.</p><button type="button" class="btn" disabled={busy() || drafts().length >= 6} onClick={() => input?.click()}>Upload field photos</button></div>}>
        {p => <>
          <div class="field-image-photo">
            <Show when={src() && imageError() !== src()} fallback={<p role="status">This image could not load. Refresh photos to try again.</p>}>
              <img src={src()} onError={() => setImageError(src())} alt={showPrediction() ? `AI growth estimate for ${formatDay(props.date)}, based on field photo taken ${formatDay(p().capturedOn)}` : `Field photo taken ${formatDay(p().capturedOn)}`} />
            </Show>
            <span class="field-image-badge">{showPrediction() ? 'Predicted with AI' : 'Original photo'} · {formatDay(showPrediction() ? props.date : p().capturedOn)}</span>
          </div>
          <Show when={!showPrediction()}><PhotoCoverage coverage={p().coverage} busy={busy()} live={live()} onRetry={() => void measure(p())}/></Show>
          <div class="field-image-action">
            <div><strong>{formatDay(p().capturedOn)} → {formatDay(props.date)}</strong><p>{showPrediction() ? prediction()?.guidance?.weather.kind === 'typical' ? 'AI growth estimate with seasonal weather. Exact weather on this date is not yet forecast.' : 'AI-generated growth estimate, not an observation. Actual growth may differ.' : 'See how your crop may have grown from this photo to the selected date.'}</p></div>
            <Show when={prediction()?.status === 'ready'} fallback={<button type="button" class="btn compact secondary" disabled={busy() || pending() || !dateAllowed() || props.date > maxDate() || (!!prediction() && !canRetryFieldPhotoPrediction(prediction()?.failureReason))} onClick={() => void predict()}><AiSparkIcon size={16}/>{pending() ? 'Predicting…' : prediction() ? 'Retry prediction' : 'Predict with AI'}</button>}>
              <button type="button" class="btn secondary" aria-pressed={original()} onClick={() => setOriginal(v => !v)}>{original() ? 'Show AI prediction' : 'Compare original'}</button>
            </Show>
          </div>
          <Show when={expected()}>{estimate => <details class="field-image-evidence field-image-comparison">
            <summary>{priorExpectation() ? 'Expected vs actual' : 'Retrospective estimate vs actual'} · {formatDay(p().capturedOn)}</summary>
            <p>{priorExpectation() ? 'This prediction was saved before the actual photo was added.' : 'This estimate was generated after the observation was added; it is not a prior forecast.'} Photos may have different viewpoints.</p>
            <div class="field-image-compare-grid"><figure><img src={safeImage(estimate().imagePath)} alt="Expected crop appearance"/><figcaption>{priorExpectation() ? 'Earlier AI expectation' : 'Retrospective AI estimate'}</figcaption></figure><figure><img src={safeImage(p().imagePath)} alt="Actual field observation"/><figcaption>Actual · {formatDay(p().capturedOn)}</figcaption><PhotoCoverage coverage={p().coverage} compact/></figure></div>
          </details>}</Show>
          <Show when={prediction()?.outdated}>
            <div class="field-image-outdated"><p>This preview used older growth guidance without target-day weather.</p><button class="btn secondary" type="button" disabled={busy() || !dateAllowed() || props.date > maxDate()} onClick={() => void predict()}>Regenerate with stage &amp; weather</button></div>
          </Show>
          <Show when={prediction()?.guidance}>{g => <details class="field-image-evidence"><summary>{g().targetStage} · {g().weather.summary}</summary><p>Photo stage: {g().sourceStage}. Advance {g().elapsedDays} days to crop age {g().targetAgeDays} days.</p><p>{g().growth}</p><p>Weather since photo: {g().interval.observedDays} recorded days, {g().interval.forecastDays} forecast days, {g().interval.typicalDays} seasonal days{g().interval.missingDays ? `, ${g().interval.missingDays} days missing` : ''}.</p><For each={g().limitations}>{note => <p>{note}</p>}</For></details>}</Show>
          <Show when={!dateAllowed()}><p class="field-image-note">Move the season slider to a date after {formatDay(p().capturedOn)} to predict growth.</p></Show>
          <Show when={props.date > maxDate()}><p class="field-image-note">Choose a date within 120 days of today.</p></Show>
          <Show when={prediction()?.status === 'failed' || prediction()?.status === 'unavailable'}><p role="status" class="field-image-note">{failureText(prediction()?.failureReason ?? null)}</p></Show>
        </>}
      </Show>
      <div class="field-images-toolbar"><strong>{gallery().photos.length} / 6 photos</strong><button type="button" class="text-button" disabled={busy() || gallery().photos.length + drafts().length >= 6} onClick={() => input?.click()}>Add photos</button><button type="button" class="text-button" disabled={busy()} onClick={() => { polls = 0; setMessage(''); setImageError(undefined); void refresh().catch(e => alive && setMessage(e.message)); }}>Refresh photos</button></div>
      <div class="field-image-thumbnails" role="group" aria-label="Field photos">
        <For each={allPhotos()}>{p => <div class="field-image-thumbnail">
          <button type="button" aria-pressed={photo()?.id === p.id} aria-label={`View photo taken ${formatDay(p.capturedOn)}`} onClick={() => { setSelected(p.id); setOriginal(false); }}><img src={safeImage(p.imagePath)} alt="" loading="lazy"/><span>{formatDay(p.capturedOn, false)}</span></button>
          <div><Show when={!p.journalEntryId} fallback={<span>Journal photo</span>}><button type="button" class="text-button" disabled={busy() || drafts().length > 0} onClick={() => setDrafts([{mediaId: p.mediaId, date: p.capturedOn, exif: false, name: 'Edit photo date', imagePath: p.imagePath}])}>Edit date</button><button type="button" class="text-button" disabled={busy()} aria-label={`Remove photo taken ${formatDay(p.capturedOn)}`} onClick={() => void remove(p)}>Remove</button></Show></div>
        </div>}</For>
      </div>
    </Show>
    <input ref={input} class="field-image-input" type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="Upload field photos" disabled={busy()} onChange={e => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; void upload(files); }}/>
    <Show when={drafts().length}>
      <form class="field-image-dates" aria-label="Confirm photo dates" onSubmit={e => {e.preventDefault(); void save();}}>
        <h3>When were these photos taken?</h3><p>Check the prefilled date for each photo and edit it if needed.</p>
        <For each={drafts()}>{d => <label><img src={safeImage(d.imagePath)} alt=""/><span>{d.name}<small>{d.exif ? 'Date from photo EXIF' : 'No EXIF date used — please confirm the date'}</small></span><input type="date" required max={props.today} aria-label={`Date taken for ${d.name}`} value={d.date} onInput={e => setDrafts(ds => ds.map(item => item.mediaId === d.mediaId ? {...item, date: e.currentTarget.value} : item))}/></label>}</For>
        <div><button class="btn" type="submit" disabled={busy()}>Save photo dates</button><button class="btn secondary" type="button" disabled={busy()} onClick={() => setDrafts([])}>Cancel</button></div>
      </form>
    </Show>
    <Show when={busy()}><p role="status" class="field-image-note">Saving your request…</p></Show>
    <Show when={message()}><p role="alert" class="field-image-error">{message()}</p></Show>
  </div>;
}
