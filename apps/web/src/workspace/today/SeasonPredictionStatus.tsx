import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { apiRequest } from '../../features/photo-region/http';
interface Status {state:string; pending:number; result:{results?:{date:string;name:string;kind:string;status:string;reason?:string}[]}|null}
const reason = (value?:string) => value === 'no_earlier_source' ? 'Needs an image taken before this date' : value === 'outside_forecast_horizon' ? 'Will be eligible within 120 days' : /limit|budget/.test(value ?? '') ? 'Waiting for prediction allowance' : value ? value.replaceAll('_',' ') : '';
export function SeasonPredictionStatus(props:{farmId:string;cycleId:string;onRefresh?:()=>void}) {
  const [status,setStatus] = createSignal<Status|null>(null);
  let lastProgress = '';
  let timer:ReturnType<typeof setTimeout>|undefined, alive=true, polls=0;
  async function refresh() {
    try {
      const next = (await apiRequest<Status>(`/api/v1/farms/${props.farmId}/cycles/${encodeURIComponent(props.cycleId)}/season-predictions`)).data;
      if (alive && next && typeof next.state === 'string') {
        setStatus(next);
        const progress = `${next.state}:${next.pending}`;
        if (progress !== lastProgress && (lastProgress || next.pending)) props.onRefresh?.();
        lastProgress = progress;
      }
    } catch { /* Status must not interrupt timeline navigation. */ }
    if (alive && polls++ < 40 && (polls < 3 || status()?.pending || ['queued','running'].includes(status()?.state ?? ''))) timer=setTimeout(() => void refresh(),6000);
  }
  onMount(() => void refresh()); onCleanup(() => {alive=false;clearTimeout(timer);});
  return <details class="today-milestone-status"><summary>{status()?.pending || ['queued','running'].includes(status()?.state ?? '') ? 'Preparing milestone previews…' : 'Automatic milestone previews'}</summary>
    <p>New photos, usable satellite scenes and dated journal observations refresh these previews. Earlier predictions are kept for comparison. Dates are approximate; harvest uses the middle of its estimated window unless recorded.</p>
    <p>A source image must be older than the target date. Automatic generation respects the AI budget and the 120-day horizon.</p>
    <Show when={status()?.state === 'failed'}><p>Milestone scheduling could not finish. Refresh this view to check again.</p></Show>
    <For each={status()?.result?.results}>{r => <p>{r.name} · {r.date} · {r.kind === 'photo' ? 'Field photo' : 'Satellite'}: {reason(r.reason) || (r.status === 'queued' || r.status === 'running' ? 'Requested' : r.status)}</p>}</For>
  </details>;
}
