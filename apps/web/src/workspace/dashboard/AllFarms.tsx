import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useWorkspace, type GeoFarm } from '../state';
import { areaText } from '../fields/fieldsModel';
import { FarmsMap } from './FarmsMap';
import { cropLabels, farmArea, farmTotals, isDemo, loadFarmWorkspaces, type FarmLoads } from './model';
import './dashboard.css';
import { emptyPriorities, loadPriorities, type Priority } from './priorities';
import { createSummaryLoader, type SummaryLoads } from './summaries';
import { FarmSummaryHeadline, FarmSummaryPanel } from './FarmSummary';
export function AllFarms() {
  const s = useWorkspace(),
    navigate = useNavigate();
  const [loads, setLoads] = createSignal<FarmLoads>({});
  const [loadsEpoch, setLoadsEpoch] = createSignal(-1);
  const [reload, setReload] = createSignal(0);
  const [segment, setSegment] = createSignal<'alerts' | 'tasks'>('alerts');
  const [priority, setPriority] = createSignal<Priority>();
  const [summaries, setSummaries] = createSignal<SummaryLoads>({});
  const [summaryEpoch, setSummaryEpoch] = createSignal(-1);
  let summaryGeneration = 0, summaryAttemptEpoch = -1;
  const summaryAttempts = new Set<string>();
  let summaryLoader: ReturnType<typeof createSummaryLoader> | undefined;
  let generation = 0,
    priorityRequest = 0,
    disposed = false;
  onCleanup(() => {
    disposed = true;
    generation++;
    priorityRequest++;
    summaryGeneration++;
    summaryLoader?.dispose();
  });
  const farms = () => s.farms.error ? [] : s.farms() ?? [];
  const selectedFarm = () => s.farms.error ? undefined : s.farm();
  const visibleLoads = () => loadsEpoch() === s.sessionEpoch() ? loads() : {};
  const visibleSummaries = () => summaryEpoch() === s.sessionEpoch() ? summaries() : {};
  createEffect(on(() => [s.sessionEpoch(), farms().map(farm => farm.id).join('|')] as const, ([epoch]) => {
    summaryLoader?.dispose();
    const run = ++summaryGeneration;
    const ids = untrack(() => farms().map(farm => farm.id));
    if (summaryAttemptEpoch !== epoch) { summaryAttempts.clear(); summaryAttemptEpoch = epoch; }
    setSummaryEpoch(epoch);
    setSummaries({});
    const selected = untrack(() => selectedFarm()?.id);
    summaryLoader = createSummaryLoader({
      ids, attempted: summaryAttempts, ...(selected ? { selected } : {}),
      current: () => !disposed && run === summaryGeneration && epoch === s.sessionEpoch(),
      publish: (id, entry) => setSummaries(previous => ({ ...previous, [id]: entry })),
    });
  }));
  createEffect(on(() => selectedFarm()?.id, id => summaryLoader?.prioritize(id)));
  createEffect(on(() => [s.sessionEpoch(), farms().map(f => f.id).join('|'), reload()] as const, ([epoch]) => {
    const run = ++generation;
    const ids = untrack(() => farms().map(f => f.id));
    setLoadsEpoch(epoch);
    setLoads(Object.fromEntries(ids.map(id => [id, {
      status: 'loading' as const
    }])));
    void loadFarmWorkspaces(ids, (id, state) => setLoads(previous => ({
      ...previous,
      [id]: state
    })), () => !disposed && run === generation && epoch === s.sessionEpoch());
  }));
  createEffect(on(() => [s.sessionEpoch(), selectedFarm()?.id] as const, ([epoch, id]) => {
    const request = ++priorityRequest;
    setPriority(undefined);
    setSegment('alerts');
    if (!id) return;
    const current = () => !disposed && request === priorityRequest && epoch === s.sessionEpoch() && selectedFarm()?.id === id;
    setPriority(emptyPriorities(id, epoch));
    void loadPriorities(id, epoch, current, setPriority);
  }));
  const totals = createMemo(() => farmTotals(farms(), visibleLoads()));
  const selectedLoad = () => selectedFarm() ? visibleLoads()[selectedFarm()!.id] : undefined;
  const selectedArea = () => selectedFarm() ? farmArea(selectedFarm()!, selectedLoad()) : null;
  const reading = () => {
    const r = priority();
    return r?.epoch === s.sessionEpoch() && r.farmId === selectedFarm()?.id ? r : undefined;
  };
  function openFarm(farm: GeoFarm, tab = 'today', field?: string) {
    s.selectFarm(farm.id);
    navigate(`/farm?tab=${tab}${field ? `&field=${encodeURIComponent(field)}` : ''}`);
  }
  const cropText = (farm: GeoFarm) => {
    const l = visibleLoads()[farm.id];
    if (!l || l.status === 'loading') return 'Loading crop records…';
    if (l.status === 'error') return 'Crop records unavailable';
    const labels = cropLabels(l.workspace, s.cropName);
    return labels.length ? labels.join(' · ') : 'No growing crops recorded';
  };
  return <div class="all-farms-dashboard">
    <header class="af-heading">
      <div>
        <p class="af-kicker">Your workspace</p>
        <h1>All farms, one perspective.</h1>
        <p>Saved land, growing crops and the next step for your selected farm.</p>
      </div>
      <a class="af-button af-secondary" href="/farm/setup">Add a farm</a>
    </header>
    <Show when={s.farms.error || !s.farms.loading} fallback={<div class="af-panel" role="status">Loading your farms…</div>}>
      <Show when={!s.farms.error} fallback={<div class="af-panel" role="alert">
          <h2>Your farms could not load</h2>
          <p>Check your connection and try again.</p>
          <button class="af-button" onClick={() => void s.refreshFarms()}>Try again</button>
        </div>}>
        <Show when={farms().length} fallback={<div class="af-panel af-empty">
            <h2>Your growing world starts here</h2>
            <p>Add your first farm to keep its boundaries, crops and care records together.</p>
            <a class="af-button" href="/farm/setup">Add your first farm</a>
          </div>}>
          <div class="af-totals" aria-label="All farms totals">
            <div>
              <strong>{totals().farms}</strong>
              <span>Saved farms</span>
            </div>
            <div>
              <strong>{totals().loaded ? totals().fields : '—'}{totals().loaded > 0 && totals().loaded < totals().farms ? '+' : ''}</strong>
              <span>Fields {totals().loaded < totals().farms ? `· ${totals().loaded}/${totals().farms} farms loaded` : '· all farms'}</span>
            </div>
            <div>
              <strong>{totals().areaKnown ? totals().areaHa.toFixed(2) : '—'}<small> ha</small>
              </strong>
              <span>{totals().areaKnown === totals().farms ? 'Total saved area' : `Known area · ${totals().areaKnown}/${totals().farms} farms`} · boundaries or recorded area</span>
            </div>
          </div>
          <Show when={totals().failed}>
            <p class="af-load-note" role="status">{totals().failed} farm workspace{totals().failed === 1 ? '' : 's'} unavailable. Counts remain partial. <button onClick={() => setReload(v => v + 1)}>Retry workspace reads</button>
            </p>
          </Show>
          <FarmsMap farms={farms()} loads={visibleLoads()} selected={selectedFarm()?.id} onSelect={s.selectFarm} />
          <div class="af-grid">
            <section class="af-panel af-farm-list" aria-label="Your farms">
              <div class="af-panel-title">
                <h2>Your farms</h2>
                <span>Select to review</span>
              </div>
              <For each={farms()}>{farm => {
                  const area = () => farmArea(farm, visibleLoads()[farm.id]);
                  const count = () => {
                    const l = visibleLoads()[farm.id];
                    return l?.status === 'ready' ? `${l.workspace.fields?.length ?? 0} fields` : l?.status === 'error' ? 'Fields unavailable' : 'Loading fields…';
                  };
                  return <button class="af-farm-row" classList={{
                    selected: selectedFarm()?.id === farm.id
                  }} aria-pressed={selectedFarm()?.id === farm.id} onClick={() => s.selectFarm(farm.id)}>
                  <span class="af-farm-dot" aria-hidden="true" />
                  <span>
                    <strong>{farm.name}</strong>
                    <FarmSummaryHeadline entry={visibleSummaries()[farm.id]} />
                    <small>{cropText(farm)}</small>
                    <small>{area() ? `${area()!.ha.toFixed(2)} ha · ` : ''}{count()}</small>
                  </span>
                  <Show when={isDemo(farm)}>
                    <span class="af-badge">Demo</span>
                  </Show>
                </button>;
                }}</For>
            </section>
            <Show when={selectedFarm()}>{farm => <section class="af-panel af-selected" aria-label="Selected farm details">
                <div class="af-panel-title">
                  <div>
                    <p class="af-kicker">Selected farm</p>
                    <h2>{farm().name}</h2>
                  </div>
                  <Show when={isDemo(farm())}>
                    <span class="af-badge">Demo farm</span>
                  </Show>
                </div>
                <p>{[farm().location.districtName, farm().location.stateCode].filter(Boolean).join(' · ') || 'Location not recorded'}</p>
                <Show when={selectedArea()}>{area => <div class="af-area">
                    <strong>{areaText(area().ha)}</strong>
                    <small>{area().basis === 'drawn boundary' ? 'Calculated from the drawn boundary · not a survey' : 'Recorded farm area'}</small>
                  </div>}</Show>
                <FarmSummaryPanel entry={visibleSummaries()[farm().id]} onRetry={() => summaryLoader?.retry(farm().id)} onActions={() => openFarm(farm(), 'actions')} />
                <div class="af-links">
                  <button class="af-button" onClick={() => openFarm(farm())}>Open farm today ↗</button>
                  <button class="af-button af-secondary" onClick={() => openFarm(farm(), 'soil')}>Farm records</button>
                </div>
              </section>}</Show>
            <section class="af-panel af-priorities" aria-label="Selected farm alerts and tasks">
              <div class="af-panel-title">
                <div>
                  <p class="af-kicker">{selectedFarm()?.name} only</p>
                  <h2>Alerts & actions</h2>
                </div>
                <Show when={reading()?.mode}>
                  <span class="af-badge">{reading()?.mode}</span>
                </Show>
              </div>
              <div class="af-segments" role="group" aria-label="Show selected farm alerts or tasks">
                <button aria-pressed={segment() === 'alerts'} onClick={() => setSegment('alerts')}>Alerts</button>
                <button aria-pressed={segment() === 'tasks'} onClick={() => setSegment('tasks')}>Care tasks</button>
              </div>
              <Show when={reading() && reading()?.status !== 'loading'} fallback={<p role="status">Loading selected farm priorities…</p>}>
                <Show when={segment() === 'alerts'} fallback={<Show when={!reading()?.tasksError} fallback={<p role="status">Care tasks could not load. Open the farm’s Actions view to retry.</p>}>
                    <Show when={reading()?.tasks.length} fallback={<p>No open source-scheduled care tasks. Field checks and issues are available in Actions.</p>}>
                      <For each={reading()?.tasks.slice(0, 5)}>{({
                        task,
                        fieldId
                      }) => <button class="af-priority-row" onClick={() => {
                        const f = selectedFarm();
                        if (f) openFarm(f, 'actions', fieldId);
                      }}>
                          <span>
                            <strong>{task.title}</strong>
                            <small>{task.dueFrom} – {task.dueTo} · {task.status}</small>
                            <small>Source schedule · review conditions in Actions</small>
                          </span>
                          <span aria-hidden="true">↗</span>
                        </button>}</For>
                    </Show>
                  </Show>}>
                  <Show when={!reading()?.alertsError} fallback={<p role="status">Alerts could not load. Open the farm’s Actions view to retry.</p>}>
                    <Show when={reading()?.alerts.length} fallback={<p>No active stored alerts for this farm.</p>}>
                      <For each={reading()?.alerts.slice(0, 5)}>{alert => <button class="af-priority-row" onClick={() => {
                          const f = selectedFarm();
                          if (f) openFarm(f, 'actions', alert.fieldId);
                        }}>
                          <span>
                            <strong>{alert.title}</strong>
                            <small>{alert.severity} · {alert.fieldId ? 'Field alert' : 'Farm-wide'} · {alert.source.date}</small>
                            <small>{alert.source.name}</small>
                          </span>
                          <span aria-hidden="true">↗</span>
                        </button>}</For>
                    </Show>
                  </Show>
                </Show>
              </Show>
              <Show when={reading()?.asOf}>
                <p class="af-asof">As of {reading()?.asOf?.slice(0, 10)} · stored alerts and source schedules</p>
              </Show>
              <button class="af-text-link" onClick={() => {
                const f = selectedFarm();
                if (f) openFarm(f, 'actions');
              }}>Open all actions, field checks & issues ↗</button>
            </section>
          </div>
        </Show>
      </Show>
    </Show>
  </div>;
}
