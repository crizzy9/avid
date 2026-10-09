import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CrossPointClient, validateCrossPointTransferPlan, type CrossPointReadiness, type CrossPointTransferPlan, type CrossPointVerification } from './crosspoint';

export interface CrossPointFileSource { id: string; name: string; load: () => Promise<Blob> }
export interface CrossPointPanelProps {
  accountScope?: string;
  fileSources?: CrossPointFileSource[];
  /** Only pass a native fetch bridge that has actually been registered and validated. */
  nativeFetch?: typeof fetch;
}

export function CrossPointPanel({ accountScope = 'local', fileSources = [], nativeFetch }: CrossPointPanelProps) {
  const id = useId();
  const client = useMemo(() => new CrossPointClient({ fetch: nativeFetch,
    transport: nativeFetch ? 'injected-native-fetch' : 'browser-fetch' }), [nativeFetch]);
  const storageKey = `avid:crosspoint:last-transfer:${encodeURIComponent(accountScope)}`;
  const [address, setAddress] = useState('crosspoint.local');
  const [fallback, setFallback] = useState('');
  const [directory, setDirectory] = useState('/');
  const [device, setDevice] = useState<CrossPointReadiness | null>(null);
  const [sourceId, setSourceId] = useState('local');
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<CrossPointTransferPlan | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<CrossPointVerification | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    setPlan(null); setDevice(null); setAttempted(false); setResult(null); setError('');
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) { const recovered: unknown = JSON.parse(saved); validateCrossPointTransferPlan(recovered); setPlan(recovered); setAttempted(true); }
    } catch { /* Malformed local state is not a transfer request. */ }
    return () => { epoch.current++; abort.current?.abort(); };
  }, [client, storageKey]);

  function invalidate() { setDevice(null); setPlan(null); setAttempted(false); setResult(null); setError(''); }
  async function run(label: string, action: (signal: AbortSignal, stillCurrent: () => boolean) => Promise<void>) {
    abort.current?.abort();
    const controller = new AbortController(); abort.current = controller;
    const current = ++epoch.current;
    setBusy(label); setError('');
    try { await action(controller.signal, () => epoch.current === current); }
    catch (failure) { if (epoch.current === current) setError(failure instanceof Error ? failure.message : 'The device request failed.'); }
    finally { if (epoch.current === current) setBusy(''); }
  }

  function inspect() {
    void run('Checking reader…', async (signal, current) => {
      const readiness = await client.inspect(address, { ipFallback: fallback || undefined, directory, signal });
      if (current()) { setDevice(readiness); setPlan(null); setAttempted(false); setResult(null); }
    });
  }
  function prepare() {
    if (!device) return;
    void run('Preparing EPUB…', async (signal, current) => {
      const source = fileSources.find(item => item.id === sourceId);
      const bytes = sourceId === 'local' ? file : await source?.load();
      const name = sourceId === 'local' ? file?.name : source?.name;
      if (!bytes || !name) throw new Error('Choose an EPUB to send.');
      const next = await client.prepare(device, bytes, name, signal);
      if (current()) { setPlan(next); setAttempted(false); setResult(null); }
    });
  }
  function send() {
    if (!plan || attempted) return;
    const pending = plan;
    setAttempted(true);
    // Save only receipt metadata, never book bytes or BookOrbit credentials.
    try { localStorage.setItem(storageKey, JSON.stringify(pending)); } catch { /* The current view retains its receipt. */ }
    void run('Sending and verifying EPUB…', async (signal, current) => {
      const verification = await client.send(pending, signal);
      if (current()) setResult(verification);
    });
  }
  function verify() {
    if (!plan) return;
    const pending = plan;
    void run('Verifying device copy…', async (signal, current) => {
      const verification = await client.verify(pending, signal);
      if (current()) setResult(verification);
    });
  }

  return <div className="crosspoint-panel" style={{ display: 'grid', gap: 14 }}>
    <p>Open <strong>File Transfer</strong> on your CrossPoint reader and join the same network. Enter its address, then choose an EPUB.</p>
    <label htmlFor={`${id}-address`}>Reader address</label>
    <input id={`${id}-address`} value={address} disabled={!!busy} autoCapitalize="none" spellCheck={false}
      placeholder="crosspoint.local or 192.168.1.42" onChange={event => { setAddress(event.target.value); invalidate(); }} />
    <label htmlFor={`${id}-fallback`}>Fallback IP <span className="muted">(optional)</span></label>
    <input id={`${id}-fallback`} value={fallback} disabled={!!busy} placeholder="IP shown on the reader" autoCapitalize="none"
      onChange={event => { setFallback(event.target.value); invalidate(); }} />
    <label htmlFor={`${id}-directory`}>Existing destination folder</label>
    <input id={`${id}-directory`} value={directory} disabled={!!busy} placeholder="/Books" onChange={event => { setDirectory(event.target.value); invalidate(); }} />
    <button className="secondary-button" disabled={!!busy} onClick={inspect}>Check reader</button>
    {device && <div>
      <p><strong>{device.device.device ?? 'CrossPoint'} · Firmware {device.device.version}</strong><br />{device.files.length} items in {device.directory}. Connected at {device.device.ip}.</p>
      <p className="muted">This firmware has not completed Avid’s physical-device qualification. Each transfer is checked by downloading the file again.</p>
      {fileSources.length > 0 && <><label htmlFor={`${id}-source`}>EPUB source</label><select id={`${id}-source`} value={sourceId} disabled={!!busy}
        onChange={event => { setSourceId(event.target.value); setPlan(null); setAttempted(false); setResult(null); }}>
        <option value="local">Choose a file from this device</option>{fileSources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select></>}
      {sourceId === 'local' && <><label htmlFor={`${id}-file`}>EPUB file</label><input id={`${id}-file`} type="file" accept=".epub,application/epub+zip" disabled={!!busy}
        onChange={event => { setFile(event.target.files?.[0] ?? null); setPlan(null); setAttempted(false); setResult(null); }} /></>}
      <button className="secondary-button" style={{ marginTop: 12 }} disabled={!!busy || (sourceId === 'local' && !file)} onClick={prepare}>Review transfer</button>
    </div>}
    {plan && <div style={{ overflowWrap: 'anywhere' }}>
      <p><strong>{plan.originalName}</strong><br />Send to {plan.device.address}{plan.directory === '/' ? '' : plan.directory}/{plan.destinationName}</p>
      <p className="muted">{(plan.size / 1024 / 1024).toFixed(2)} MB · A unique filename keeps existing books intact.</p>
      {!attempted ? <button className="primary-button" disabled={!!busy} onClick={send}>Send EPUB</button> :
        <button className="secondary-button" disabled={!!busy} onClick={verify}>Verify again</button>}
    </div>}
    {busy && <div role="status">{busy} <button className="text-button" onClick={() => abort.current?.abort()}>Cancel</button></div>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {result && <p role="status"><strong>{result.state === 'verified' ? 'Transfer verified.' : 'Transfer needs review.'}</strong> {result.message}</p>}
    <p className="muted">Direct local-network access depends on your browser. If it blocks the connection, use the reader’s own file manager or an Avid build with a verified native transport.</p>
  </div>;
}
