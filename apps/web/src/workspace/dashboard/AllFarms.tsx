import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { useWorkspace, type GeoFarm } from '../state';
import { areaText, HA_TO_ACRES } from '../fields/fieldsModel';
import { Icon } from '../icons';
import type { FocusRect, MapCommand } from '../mapLayer';
import { FarmsMap, type FarmsMapStatus } from './FarmsMap';
import { cropLabels, farmArea, farmTotals, isDemo, loadFarmWorkspaces, type FarmLoads } from './model';
import './dashboard.css';
import { loadPriorityCohort, type Priority } from './priorities';
import { createSummaryLoader, type SummaryLoads } from './summaries';
import { FarmSummaryPanel } from './FarmSummary';
import { activeFieldCount, farmStatus, nextPlannedTask, openReviewCount, openReviewsTotal, pinNumber, severityLabel, shortDate, taskWhen, todaysTasks } from './status';

const alertIcon = (type: string) => (type === 'weather' ? 'rain' : type === 'price' || type === 'market_event' ? 'trend' : type === 'satellite' ? 'layers' : 'leaf');

/**
 * All farms (docs/research/ALL_FARMS_LAYOUT_SPEC.md): the farms map fills the route behind floating panels (a top band on
 * a phone); the header and totals sit top left without a panel; the farm list with one status chip per farm and the
 * selected-farm card form the left column; "Alerts & tasks" for the selected farm is the right column. Reads: the farm
 * list, each farm's workspace, each farm's stored alerts and command center (care schedules), and each farm's summary.
 */
export function AllFarms() {
  const s = useWorkspace(),
    navigate = useNavigate();
  const [loads, setLoads] = createSignal<FarmLoads>({});
  const [loadsEpoch, setLoadsEpoch] = createSignal(-1);
  const [reload, setReload] = createSignal(0);
  const [segment, setSegment] = createSignal<'alerts' | 'tasks'>('alerts');
  const [priorities, setPriorities] = createSignal<Record<string, Priority>>({});
  const [prioritiesEpoch, setPrioritiesEpoch] = createSignal(-1);
  const [summaries, setSummaries] = createSignal<SummaryLoads>({});
  const [summaryEpoch, setSummaryEpoch] = createSignal(-1);
  const [focus, setFocus] = createSignal<FocusRect | null>(null, { equals: (a, b) => a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom) });
  const [mapStatus, setMapStatus] = createSignal<FarmsMapStatus>({ located: 0, layer: 'flat' });
  const [viewportWidth, setViewportWidth] = createSignal(typeof window === 'undefined' ? 0 : window.innerWidth);
  let mapCommand: ((command: MapCommand) => void) | undefined;
  let centre: HTMLDivElement | undefined;
  let summaryGeneration = 0, summaryAttemptEpoch = -1;
  const summaryAttempts = new Set<string>();
  let summaryLoader: ReturnType<typeof createSummaryLoader> | undefined;
  let generation = 0,
    priorityGeneration = 0,
    disposed = false;
  onCleanup(() => {
    disposed = true;
    generation++;
    priorityGeneration++;
    summaryGeneration++;
    summaryLoader?.dispose();
  });
  const farms = () => s.farms.error ? [] : s.farms() ?? [];
  const selectedFarm = () => s.farms.error ? undefined : s.farm();
  const visibleLoads = () => loadsEpoch() === s.sessionEpoch() ? loads() : {};
  const visibleSummaries = () => summaryEpoch() === s.sessionEpoch() ? summaries() : {};
  const visiblePriorities = () => prioritiesEpoch() === s.sessionEpoch() ? priorities() : {};
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
  // Stored alerts and care schedules for every farm (status chips, open reviews), the selected farm first. Selecting a farm
  // reads nothing new; the "Alerts & tasks" panel shows the selected farm's entry.
  createEffect(on(() => [s.sessionEpoch(), farms().map(f => f.id).join('|'), reload()] as const, ([epoch]) => {
    const run = ++priorityGeneration;
    const ids = untrack(() => farms().map(f => f.id));
    setPrioritiesEpoch(epoch);
    setPriorities({});
    const current = () => !disposed && run === priorityGeneration && epoch === s.sessionEpoch();
    void loadPriorityCohort(ids, epoch, current, value => {
      if (current()) setPriorities(previous => ({ ...previous, [value.farmId]: value }));
    }, untrack(() => selectedFarm()?.id));
  }));
  createEffect(on(() => selectedFarm()?.id, () => setSegment('alerts')));
  // The open centre between the columns: the map fits the farms into it, and the credit and zoom buttons sit at its foot.
  onMount(() => {
    const measure = () => {
      setViewportWidth(window.innerWidth);
      if (!centre) return setFocus(null);
      const box = centre.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return setFocus(null);
      setFocus({ top: Math.round(box.top + window.scrollY), left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom + window.scrollY) });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (centre) observer?.observe(centre);
    window.addEventListener('resize', measure);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    });
  });
  const totals = createMemo(() => farmTotals(farms(), visibleLoads()));
  const activeFields = createMemo(() => farms().reduce((n, farm) => n + (activeFieldCount(visibleLoads()[farm.id]) ?? 0), 0));
  const reviews = createMemo(() => openReviewsTotal(farms(), visibleLoads(), visiblePriorities()));
  const selectedLoad = () => selectedFarm() ? visibleLoads()[selectedFarm()!.id] : undefined;
  const selectedArea = () => selectedFarm() ? farmArea(selectedFarm()!, selectedLoad()) : null;
  const selectedIndex = () => farms().findIndex(farm => farm.id === selectedFarm()?.id);
  const reading = () => {
    const id = selectedFarm()?.id;
    const r = id ? visiblePriorities()[id] : undefined;
    return r?.epoch === s.sessionEpoch() && r.farmId === id ? r : undefined;
  };
  const readingReady = () => {
    const r = reading();
    return r && r.status !== 'loading' ? r : undefined;
  };
  const fieldName = (fieldId: string | undefined) => {
    const l = selectedLoad();
    return fieldId && l?.status === 'ready' ? l.workspace.fields?.find(field => field.id === fieldId)?.name : undefined;
  };
  function openFarm(farm: GeoFarm, tab = 'today', field?: string) {
    s.selectFarm(farm.id);
    navigate(`/farm?tab=${tab}${field ? `&field=${encodeURIComponent(field)}` : ''}`);
  }
  const crops = (farm: GeoFarm) => {
    const l = visibleLoads()[farm.id];
    return l?.status === 'ready' ? cropLabels(l.workspace, s.cropName) : [];
  };
  const rowLine = (farm: GeoFarm) => {
    const l = visibleLoads()[farm.id];
    const area = farmArea(farm, l);
    const areaPart = area ? `${area.ha.toFixed(2)} ha` : null;
    if (!l || l.status === 'loading') return [areaPart, 'Loading fields…'].filter(Boolean).join(' · ');
    if (l.status === 'error') return [areaPart, 'Fields unavailable'].filter(Boolean).join(' · ');
    const labels = crops(farm);
    const fields = l.workspace.fields?.length ?? 0;
    return [labels.length ? labels.join(', ') : 'No growing crop', areaPart, `${fields} ${fields === 1 ? 'field' : 'fields'}`].filter(Boolean).join(' · ');
  };
  const geoVars = () => {
    const f = focus();
    if (!f) return {};
    return { '--af-cl': `${f.left}px`, '--af-cr': `${Math.max(0, viewportWidth() - f.right)}px`, '--af-ct': `${f.top}px` };
  };
  return <div class="all-farms-dashboard" style={geoVars()}>
    <Show when={!s.farms.error && farms().length}>
      <FarmsMap farms={farms()} loads={visibleLoads()} selected={selectedFarm()?.id} focus={focus()} controller={handler => { mapCommand = handler; }} onStatus={setMapStatus} />
    </Show>
    <div class="af-layout">
      <header class="af-heading">
        <div class="af-heading-copy">
          <p class="af-kicker">Your growing world</p>
          <h1>All farms, one perspective.</h1>
          <p class="af-heading-sentence">A little context for every field. Select a farm to take a closer look.</p>
        </div>
        <Show when={!s.farms.error && !s.farms.loading && farms().length}>
          <div class="af-totals" aria-label="All farms totals">
            <div>
              <strong>{totals().farms}</strong>
              <span>Farms</span>
            </div>
            <div>
              <strong>{totals().loaded ? activeFields() : '—'}{totals().loaded > 0 && totals().loaded < totals().farms ? '+' : ''}</strong>
              <span>Active fields · {totals().loaded < totals().farms ? `${totals().loaded}/${totals().farms} farms loaded` : `${totals().fields} saved`}</span>
            </div>
            <div title="From drawn boundaries or the recorded farm area">
              <strong>{totals().areaKnown ? totals().areaHa.toFixed(2) : '—'}<small> ha</small></strong>
              <span>{totals().areaKnown === totals().farms ? 'Total area' : `Known area · ${totals().areaKnown}/${totals().farms} farms`}{totals().areaKnown ? ` · ${(totals().areaHa * HA_TO_ACRES).toFixed(2)} acres` : ''}</span>
            </div>
            <div title="Stored alerts to review plus care tasks due or overdue">
              <strong>{reviews().counted ? reviews().count : '—'}</strong>
              <span>Open reviews{reviews().partial ? ' · partial' : reviews().loading ? ' · checking' : ''}</span>
            </div>
          </div>
          <Show when={totals().failed}>
            <p class="af-load-note" role="status">{totals().failed} farm workspace{totals().failed === 1 ? '' : 's'} unavailable. Counts remain partial. <button onClick={() => setReload(v => v + 1)}>Retry workspace reads</button>
            </p>
          </Show>
        </Show>
        <a class="af-button af-secondary af-add" href="/farm/setup">Add a farm</a>
      </header>
      <div class="af-left">
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
              <section class="af-panel af-farm-list" aria-labelledby="af-farms-title">
                <div class="af-panel-title">
                  <h2 id="af-farms-title">Your farms</h2>
                  <span>Select to review</span>
                </div>
                <For each={farms()}>{(farm, index) => {
                    const status = () => farmStatus(visibleLoads()[farm.id], visiblePriorities()[farm.id]);
                    return <button class="af-farm-row" classList={{
                      selected: selectedFarm()?.id === farm.id
                    }} aria-pressed={selectedFarm()?.id === farm.id} onClick={() => s.selectFarm(farm.id)}>
                      <span class="af-farm-number" aria-hidden="true">{pinNumber(index())}</span>
                      <span class="af-farm-text">
                        <strong>{farm.name}</strong>
                        <small>{rowLine(farm)}</small>
                      </span>
                      <span class="af-row-tags">
                        <span class="af-status" data-kind={status().kind} title={status().reason}>{status().label}</span>
                        <Show when={isDemo(farm)}>
                          <span class="af-badge">Demo</span>
                        </Show>
                      </span>
                    </button>;
                  }}</For>
              </section>
              <Show when={selectedFarm()}>{farm => <section class="af-panel af-selected" aria-label="Selected farm summary">
                  <div class="af-panel-title af-selected-title">
                    <div>
                      <p class="af-kicker">Selected farm{selectedIndex() >= 0 ? ` · ${pinNumber(selectedIndex())}` : ''}</p>
                      <h2>{farm().name}</h2>
                    </div>
                    <span class="af-row-tags">
                      <For each={crops(farm()).slice(0, 2)}>{crop => <span class="af-badge af-crop">{crop}</span>}</For>
                      <Show when={crops(farm()).length > 2}><span class="af-badge">+{crops(farm()).length - 2}</span></Show>
                      <Show when={isDemo(farm())}>
                        <span class="af-badge">Demo farm</span>
                      </Show>
                    </span>
                  </div>
                  <FarmSummaryPanel entry={visibleSummaries()[farm().id]} onRetry={() => summaryLoader?.retry(farm().id)}
                    actions={<div class="af-links">
                      <a class="af-button" href="/farm?tab=modify">Open field map</a>
                      <a class="af-button af-secondary" href="/farm?tab=actions">Alerts &amp; actions</a>
                    </div>}
                    details={<div class="af-selected-details">
                      <p>{[farm().location.districtName, farm().location.stateCode].filter(Boolean).join(' · ') || 'Location not recorded'}</p>
                      <Show when={selectedArea()}>{area => <p>
                          <strong>{areaText(area().ha)}</strong>{' · '}
                          {area().basis === 'drawn boundary' ? 'Calculated from the drawn boundary · not a survey' : 'Recorded farm area'}
                        </p>}</Show>
                      <p class="af-detail-links">
                        <button class="af-text-link" onClick={() => openFarm(farm())}>Open farm today ↗</button>
                        <button class="af-text-link" onClick={() => openFarm(farm(), 'soil')}>Farm records ↗</button>
                      </p>
                    </div>} />
                </section>}</Show>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="af-centre" ref={centre} aria-hidden="true" />
      <Show when={!s.farms.error && farms().length && selectedFarm()}>
        <section class="af-panel af-priorities" aria-labelledby="af-priorities-title">
          <div class="af-panel-title">
            <h2 id="af-priorities-title">Alerts &amp; tasks</h2>
            <Show when={readingReady()}>{r => <span class="af-count" data-open={openReviewCount(r()) > 0}>{openReviewCount(r())} to review</span>}</Show>
          </div>
          <p class="af-provenance">{selectedFarm()?.name} only · stored alerts and schedules<Show when={reading()?.asOf}> · as of {shortDate(reading()!.asOf!)}</Show><Show when={reading()?.mode}> · {reading()?.mode} mode</Show></p>
          <div class="af-segments" role="group" aria-label="Show selected farm alerts or tasks">
            <button aria-pressed={segment() === 'alerts'} onClick={() => setSegment('alerts')}>To review</button>
            <button aria-pressed={segment() === 'tasks'} onClick={() => setSegment('tasks')}>Today’s tasks</button>
          </div>
          <Show when={readingReady()} fallback={<p role="status">Loading selected farm priorities…</p>}>
            <Show when={segment() === 'alerts'} fallback={<Show when={!reading()?.tasksError} fallback={<p role="status">Care tasks could not load. Open the farm’s Actions view to retry.</p>}>
                <Show when={todaysTasks(reading()!).length} fallback={<p class="af-none">No care tasks due today. Field checks and issues are available in Actions.</p>}>
                  <For each={todaysTasks(reading()!).slice(0, 5)}>{({ task, fieldId }) => <button class="af-priority-row" onClick={() => {
                      const f = selectedFarm();
                      if (f) openFarm(f, 'actions', fieldId);
                    }}>
                      <span class="af-item-icon" data-severity={task.status === 'overdue' ? 'warning' : 'watch'}><Icon name="check" size={16} /></span>
                      <span class="af-item-text">
                        <strong>{task.title}</strong>
                        <small>{selectedFarm()?.name}{fieldName(fieldId) ? ` · ${fieldName(fieldId)}` : ''} · {taskWhen(task)} · source schedule</small>
                      </span>
                      <span class="af-item-jump" aria-hidden="true">↗</span>
                    </button>}</For>
                </Show>
              </Show>}>
              <Show when={!reading()?.alertsError} fallback={<p role="status">Alerts could not load. Open the farm’s Actions view to retry.</p>}>
                <Show when={reading()?.alerts.length} fallback={<p class="af-none">No active stored alerts for this farm.</p>}>
                  <For each={reading()?.alerts.slice(0, 5)}>{alert => <button class="af-priority-row" onClick={() => {
                      const f = selectedFarm();
                      if (f) openFarm(f, 'actions', alert.fieldId);
                    }}>
                      <span class="af-item-icon" data-severity={alert.severity}><Icon name={alertIcon(alert.type)} size={16} /></span>
                      <span class="af-item-text">
                        <strong>{alert.title}</strong>
                        <small>{selectedFarm()?.name}{fieldName(alert.fieldId) ? ` · ${fieldName(alert.fieldId)}` : alert.fieldId ? ' · Field alert' : ' · Farm-wide'} · {severityLabel(alert.severity)} · {alert.source.name}, {shortDate(alert.source.date)}</small>
                      </span>
                      <span class="af-item-jump" aria-hidden="true">↗</span>
                    </button>}</For>
                </Show>
              </Show>
            </Show>
            <div class="af-next-task">
              <p class="af-kicker">Next planned field task</p>
              <Show when={!reading()?.tasksError} fallback={<p class="af-none">Care schedules could not load.</p>}>
                <Show when={nextPlannedTask(reading()!)} fallback={<p class="af-none">{todaysTasks(reading()!).length ? 'No further field task scheduled' : 'No field task scheduled'}</p>}>{next => <>
                    <h3>{next().task.title}</h3>
                    <p>{selectedFarm()?.name}{fieldName(next().fieldId) ? ` · ${fieldName(next().fieldId)}` : ''} · {shortDate(next().task.dueFrom, true)}{next().task.dueTo !== next().task.dueFrom ? ` – ${shortDate(next().task.dueTo, true)}` : ''} · source schedule</p>
                    <button class="af-text-link" onClick={() => {
                      const f = selectedFarm();
                      if (f) openFarm(f, 'actions', next().fieldId);
                    }}>Review task ↗</button>
                  </>}</Show>
              </Show>
            </div>
          </Show>
          <button class="af-text-link" onClick={() => {
            const f = selectedFarm();
            if (f) openFarm(f, 'actions');
          }}>Open all actions, field checks &amp; issues ↗</button>
        </section>
      </Show>
    </div>
    <Show when={mapStatus().located}>
      <div class="af-map-controls" role="group" aria-label="Map view">
        <button type="button" aria-label="Zoom in" onClick={() => mapCommand?.('zoom-in')}><span aria-hidden="true">+</span></button>
        <button type="button" aria-label="Zoom out" onClick={() => mapCommand?.('zoom-out')}><span aria-hidden="true">−</span></button>
        <button type="button" aria-label="Show all farms on the map" onClick={() => mapCommand?.('recenter')}><Icon name="target" size={17} /></button>
      </div>
    </Show>
  </div>;
}
