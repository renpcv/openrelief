import * as THREE from 'three';
import { writeExr, writePfm, writePng16 } from './export/image';
import { buildGrid, type ReliefDimensions, writeObj, writeStl } from './export/mesh';
import { createDemoModel, loadModelFile } from './loaders';
import type { ReliefMode, ReliefParams } from './relief/relief';
import type { ReliefMessage, ReliefRequest } from './relief/worker';
import { type TransformMode, Viewport, type ViewMode } from './viewport';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const input = (id: string) => $<HTMLInputElement>(`#${id}`);
const num = (id: string) => Number(input(id).value);

const view = new Viewport($('#viewport'));
const status = $('#status');
const generateBtn = $<HTMLButtonElement>('#generate');
const progress = $('#progress');
const reliefTab = $<HTMLButtonElement>('#tabs [data-view="relief"]');

interface Relief {
  width: number;
  height: number;
  /** Normalised heights, 0..1. */
  data: Float32Array;
}
let relief: Relief | null = null;
let worker: Worker | null = null;
const PREVIEW_MAX = 1024;

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

// ------------------------------------------------------------------ models

async function importFiles(files: Iterable<File>): Promise<void> {
  for (const file of files) {
    try {
      setStatus(`Loading ${file.name}…`);
      view.addModel(file.name, await loadModelFile(file));
      setStatus(`Loaded ${file.name}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }
}

$('#import').onclick = () => input('file').click();
input('file').onchange = () => {
  void importFiles(input('file').files ?? []);
  input('file').value = '';
};
$('#demo').onclick = async () => {
  setStatus('Building demo model…');
  await new Promise((r) => setTimeout(r)); // let the status paint first
  try {
    view.addModel('Demo knot', createDemoModel());
    setStatus('Loaded demo model');
  } catch (err) {
    setStatus(`Demo model failed: ${err instanceof Error ? err.message : err}`, true);
  }
};

const main = $('main');
main.addEventListener('dragover', (e) => {
  e.preventDefault();
  main.classList.add('dragging');
});
main.addEventListener('dragleave', () => main.classList.remove('dragging'));
main.addEventListener('drop', (e) => {
  e.preventDefault();
  main.classList.remove('dragging');
  void importFiles(e.dataTransfer?.files ?? []);
});

function renderModelList(): void {
  const list = $('#models');
  list.replaceChildren(
    ...view.models.map((m) => {
      const li = document.createElement('li');
      li.classList.toggle('on', m === view.selection);
      const name = document.createElement('span');
      name.textContent = m.name;
      name.title = m.name;
      const tris = document.createElement('small');
      tris.textContent = `${m.triangles.toLocaleString()} tris`;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = `Remove ${m.name}`;
      del.onclick = (e) => {
        e.stopPropagation();
        view.removeModel(m);
      };
      li.append(name, tris, del);
      li.onclick = () => view.select(m);
      return li;
    }),
  );
  generateBtn.disabled = view.models.length === 0 || worker !== null;
  syncScaleSlider();
}

// Uniform scale of the selected model. The slider is logarithmic (0.05x to 20x)
// so small and large sizes are equally easy to reach.
const scaleSlider = input('uniformScale');
function syncScaleSlider(): void {
  const scale = view.selectionScale;
  scaleSlider.disabled = !view.selection;
  scaleSlider.value = String(Math.log10(scale));
  $('#uniformScaleValue').textContent = view.selection ? `${scale.toPrecision(3)}×` : '';
}
scaleSlider.addEventListener('input', () => {
  const scale = 10 ** Number(scaleSlider.value);
  view.setSelectionScale(scale);
  $('#uniformScaleValue').textContent = `${scale.toPrecision(3)}×`;
});
view.onSelect = renderModelList;
view.onChange = renderModelList;

function segmented(container: string, onPick: (button: HTMLButtonElement) => void, sticky = true) {
  const root = $(container);
  root.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button || button.disabled) return;
    if (sticky) for (const b of root.querySelectorAll('button')) b.classList.toggle('on', b === button);
    onPick(button);
  });
}

segmented('#transform', (b) => view.setTransformMode(b.dataset.mode as TransformMode));
segmented(
  '#views',
  (b) => {
    if (b.id === 'fit') view.frame();
    else {
      const [x, y, z] = b.dataset.dir!.split(',').map(Number);
      view.setViewDirection(new THREE.Vector3(x, y, z));
    }
  },
  false,
);
segmented('#tabs', (b) => showMode(b.dataset.view as ViewMode));

function showMode(mode: ViewMode): void {
  view.setMode(mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button'))
    b.classList.toggle('on', b.dataset.view === mode);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && view.selection) view.removeModel(view.selection);
});

// ------------------------------------------------------------------ settings

function refreshSliders(): void {
  for (const label of document.querySelectorAll<HTMLLabelElement>('label.slider:not(.custom)')) {
    label.querySelector('output')!.textContent = label.querySelector('input')!.value;
  }
  const mode = $<HTMLSelectElement>('#mode').value;
  for (const label of document.querySelectorAll<HTMLElement>('[data-for-mode]'))
    label.classList.toggle('off', label.dataset.forMode !== mode);
}
document.querySelector('#sidebar')!.addEventListener('input', refreshSliders);
refreshSliders();

function readParams(): ReliefParams {
  return {
    mode: $<HTMLSelectElement>('#mode').value as ReliefMode,
    compression: num('compression'),
    silhouetteStep: num('silhouette') / 100,
    occlusionStep: num('occlusion') / 100,
    discontinuitySlope: num('tau'),
    detail: num('detail'),
    detailRadius: num('detailRadius') / 100,
    smoothing: num('smoothing'),
  };
}

function readDimensions(r: Relief): ReliefDimensions {
  return {
    pixelSize: Math.max(num('size'), 0.001) / Math.max(r.width, r.height),
    depth: Math.max(num('depth'), 0),
    base: Math.max(num('base'), 0),
    sunken: $<HTMLSelectElement>('#direction').value === 'sunken',
  };
}

// ------------------------------------------------------------------ generate

function setProgress(stage: string | null, fraction = 0): void {
  progress.hidden = stage === null;
  if (stage === null) return;
  (progress.firstElementChild as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
  progress.querySelector('span')!.textContent = stage;
}

function updatePreview(): void {
  if (!relief) return;
  view.setRelief(buildGrid(relief.data, relief.width, relief.height, readDimensions(relief), PREVIEW_MAX));
}

function generate(): void {
  if (worker) return;
  showMode('scene');
  const resolution = Number($<HTMLSelectElement>('#resolution').value);
  setProgress('Capturing depth', 0);
  let capture;
  try {
    capture = view.captureDepth(resolution, num('margin') / 100);
  } catch (err) {
    setProgress(null);
    setStatus(`Depth capture failed: ${err instanceof Error ? err.message : err}`, true);
    return;
  }
  if (!capture) {
    setProgress(null);
    setStatus('Nothing to capture - import a model first.', true);
    return;
  }
  const { width, height, depth, mask } = capture;
  worker = new Worker(new URL('./relief/worker.ts', import.meta.url), { type: 'module' });
  generateBtn.disabled = true;
  const finish = () => {
    worker?.terminate();
    worker = null;
    setProgress(null);
    renderModelList();
  };
  worker.onmessage = (e: MessageEvent<ReliefMessage>) => {
    const m = e.data;
    if (m.type === 'progress') setProgress(m.stage, m.fraction);
    else if (m.type === 'error') {
      finish();
      setStatus(`Relief failed: ${m.message}`, true);
    } else {
      finish();
      relief = { width, height, data: m.height };
      updatePreview();
      reliefTab.disabled = false;
      for (const b of document.querySelectorAll<HTMLButtonElement>('#exports button')) b.disabled = false;
      showMode('relief');
      const solver = m.iterations ? `, ${m.iterations} solver iterations` : '';
      // Say so when hollows dip below the background, since that uses up part of the relief depth.
      const below = m.background > 0.02 ? `, hollows use ${Math.round(m.background * 100)}% of depth below the background` : '';
      setStatus(`${width} × ${height} px in ${(m.ms / 1000).toFixed(1)} s${solver}${below}`);
    }
  };
  worker.onerror = (e) => {
    finish();
    setStatus(`Relief failed: ${e.message || 'worker error (possibly out of memory)'}`, true);
  };
  const request: ReliefRequest = { width, height, depth, mask, params: readParams() };
  worker.postMessage(request, [depth.buffer, mask.buffer]);
}
generateBtn.onclick = generate;

for (const id of ['size', 'depth', 'base', 'direction']) input(id).addEventListener('change', updatePreview);

// ------------------------------------------------------------------ export

function download(data: Blob | ArrayBuffer, name: string): void {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function exportRelief(format: string): Promise<void> {
  if (!relief) return;
  const { width: w, height: h, data } = relief;
  const dims = readDimensions(relief);
  setStatus(`Exporting ${format.toUpperCase()}…`);
  await new Promise((r) => setTimeout(r)); // let the status paint
  try {
    if (format === 'stl' || format === 'obj') {
      const grid = buildGrid(data, w, h, dims, Number($<HTMLSelectElement>('#meshRes').value));
      download(format === 'stl' ? writeStl(grid) : writeObj(grid), `relief.${format}`);
    } else {
      // Depth maps: white / larger = closer to the viewer.
      const scale = format === 'png' ? 1 : dims.depth;
      const values = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) values[i] = (dims.sunken ? 1 - data[i] : data[i]) * scale;
      if (format === 'png') download(await writePng16(values, w, h), 'relief.png');
      else if (format === 'exr') download(writeExr(values, w, h), 'relief.exr');
      else download(writePfm(values, w, h), 'relief.pfm');
    }
    setStatus(`Exported relief.${format}`);
  } catch (err) {
    setStatus(`Export failed: ${err instanceof Error ? err.message : err}`, true);
  }
}
segmented('#exports', (b) => void exportRelief(b.dataset.format!), false);

// Debug handle for the console and automated checks; index.html also uses it to tell that the app started.
Object.assign(window, { openrelief: { view, getRelief: () => relief, generate } });
setStatus('Ready: import a model or try the demo');
