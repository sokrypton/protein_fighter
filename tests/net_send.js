// The link's two one-way valves, without a browser. The host may drop a state packet on a
// slow link, because the next one says everything it did, but never one carrying events -
// a hit, a reset, a custom fighter - which are said once and then let go of. And the
// guest, which speaks rarely, holds what it could not say until its channel comes back.
// Run with: node tests/net_send.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; };

// the least of a browser that net.js needs, and a Peer whose one connection we drive
const sent = [];
const channel = { bufferedAmount: 0 };
const guest = { open: true, who: 'token-A', dataChannel: channel, handlers: {}, on(k, f) { this.handlers[k] = f; }, send(m) { sent.push(m); }, close() {} };
let hostPeer = null;
class FakePeer {
  constructor() { hostPeer = this; this.handlers = {}; setTimeout(() => { this.handlers.open && this.handlers.open('host-id'); this.handlers.connection && this.handlers.connection(guest); }, 0); }
  on(k, f) { this.handlers[k] = f; }
  get disconnected() { return false; } get destroyed() { return false; }
  reconnect() {} destroy() {} get id() { return 'host-id'; }
}
global.window = global;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.addEventListener = () => {};
global.Peer = FakePeer;
global.performance = { now: () => Date.now() };
global.location = { origin: 'http://x', pathname: '/', href: 'http://x/' };
global.document = { getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), addEventListener() {}, visibilityState: 'visible' };
global.navigator = { onLine: true };
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const realWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).startsWith('TURN credentials')) return; realWarn(...a); };   // there is no worker here
new Function('window', fs.readFileSync(path.join(ROOT, 'net.js'), 'utf8'))(window);

(async () => {
  const link = window.Net.host({ onLink() {}, onGuest() {}, onWatcher() {}, onInput() {}, onClose() {}, onError() {}, onPing() {} });
  await new Promise(r => setTimeout(r, 1200));   // turnReady waits on the worker, which is not there
  guest.handlers.data && guest.handlers.data({ t: 'hello', role: 'player', who: 'token-A' });
  check(!!link && typeof link.send === 'function', 'the host handed back a link');

  // an open channel: everything goes
  sent.length = 0; channel.bufferedAmount = 0;
  check(link.send({ h: { f: 1, ev: [] } }) === true && sent.length === 1, 'a clear channel takes a plain state packet');
  sent.length = 0;
  check(link.send({ h: { f: 1, ev: [['custom', 1, {}]] } }) === true && sent.length === 1, 'and one carrying events');

  // a channel backed up past the gate
  sent.length = 0; channel.bufferedAmount = 64 * 1024;
  check(link.send({ h: { f: 2, ev: [] } }) === false && sent.length === 0, 'a backed-up channel drops a plain state packet, and says so');
  sent.length = 0;
  const went = link.send({ h: { f: 2, ev: [['custom', 1, { name: 'GFP' }]] } });
  check(went === true && sent.length === 1, 'but never one carrying events: a custom fighter is said once');
  sent.length = 0;
  check(link.send({ h: { f: 2, ev: [['hit', 0, 'punch']] } }) === true && sent.length === 1, 'nor one carrying a hit');

  // a closed channel: nothing goes, and send() says so, so the caller keeps its events
  sent.length = 0; guest.open = false;
  check(link.send({ h: { f: 3, ev: [['reset', []]] } }) === false && sent.length === 0, 'a closed channel sends nothing and reports it');
  guest.open = true;

  // --- a challenger coming back is not a second challenger
  // The host keeps one seat. A stranger waits while the one in it is still being heard
  // from; a guest whose link went carries the same token and takes it straight back.
  const seat = (who) => { const c = { open: true, who, closed: false, handlers: {}, dataChannel: { bufferedAmount: 0 },
    on(k, f) { this.handlers[k] = f; }, send() {}, close() { this.open = false; this.closed = true; } }; return c; };
  const arrive = (c, who) => { hostPeer.handlers.connection(c); c.handlers.data({ t: 'hello', role: 'player', who }); };

  channel.bufferedAmount = 0;   // a clear channel again, after the gate tests above
  const stranger = seat('token-B');
  arrive(stranger, 'token-B');
  check(stranger.closed, 'a stranger is turned away while the guest in the seat is still being heard from');
  sent.length = 0;
  check(link.send({ h: { f: 9, ev: [] } }) === true && sent.length === 1, 'and the one in the seat still has it');

  const returning = seat('token-A');
  arrive(returning, 'token-A');   // the same guest, its old channel still reading open
  check(!returning.closed, 'a guest carrying the same token is let back in at once');
  sent.length = 0;
  returning.send = m => sent.push(m);
  check(link.send({ h: { f: 10, ev: [] } }) === true && sent.length === 1, 'and the host streams to the new channel');

  // --- the guest's outbox  // --- the guest's outbox
  const hostConn = { open: false, handlers: {}, on(k, f) { this.handlers[k] = f; }, send(m) { toHost.push(m); }, close() {} };
  const toHost = [];
  global.Peer = class { constructor() { this.handlers = {}; setTimeout(() => this.handlers.open && this.handlers.open('guest-id'), 0); }
    on(k, f) { this.handlers[k] = f; } connect() { return hostConn; }
    get disconnected() { return false; } get destroyed() { return false; } reconnect() {} destroy() {} get id() { return 'guest-id'; } };
  const g = window.Net.join('host-id', { onOpen() {}, onState() {}, onClose() {}, onError() {} });
  await new Promise(r => setTimeout(r, 1200));
  check(!!g && typeof g.send === 'function', 'the guest handed back a link');

  // the channel is not open yet: what matters is kept, keys are not
  toHost.length = 0;
  check(g.send({ t: 'custom', spec: { name: 'GFP' } }) === false, 'a guest with no channel cannot send its fighter');
  g.send({ t: 'pick', form: 'helix' });
  g.send({ t: 'in', d: 1, a: 'punch' });   // a key pressed now, or not at all
  g.send({ t: 'custom', spec: { name: 'FUS' } });   // a second choice replaces the first
  check(toHost.length === 0, 'and nothing went out while it was shut');

  // the channel opens: the outbox goes, newest of each kind, no keys
  hostConn.open = true;
  hostConn.handlers.open && hostConn.handlers.open();
  const kinds = toHost.map(m => m.t);
  check(kinds[0] === 'hello', 'it says hello first');
  check(kinds.filter(k => k === 'custom').length === 1 && toHost.find(m => m.t === 'custom').spec.name === 'FUS',
    `its fighter follows, the newest choice only (${JSON.stringify(kinds)})`);
  check(kinds.includes('pick'), 'and the protein it picked');
  check(!kinds.includes('in'), 'but not the key it pressed while the channel was shut');

  // open now: straight out, nothing held
  toHost.length = 0;
  check(g.send({ t: 'pick', form: 'barrel' }) === true && toHost.length === 1, 'with the channel open it goes straight out');

  // --- and the outbox crosses a reconnect, which is when it is needed
  hostConn.open = false;
  g.send({ t: 'custom', spec: { name: 'across the gap' } });
  const g2 = window.Net.join('host-id', { onOpen() {}, onState() {}, onClose() {}, onError() {} });   // the same host, three seconds later
  await new Promise(r => setTimeout(r, 1200));
  toHost.length = 0; hostConn.open = true;
  hostConn.handlers.open && hostConn.handlers.open();
  const across = toHost.find(m => m.t === 'custom');
  check(!!across && across.spec.name === 'across the gap', `what it said while it was down goes on the new connection (${JSON.stringify(toHost.map(m => m.t))})`);

  // ...but a different host starts clean
  hostConn.open = false;
  g2.send({ t: 'custom', spec: { name: 'old game' } });
  window.Net.join('another-host', { onOpen() {}, onState() {}, onClose() {}, onError() {} });
  await new Promise(r => setTimeout(r, 1200));
  toHost.length = 0; hostConn.open = true;
  hostConn.handlers.open && hostConn.handlers.open();
  check(!toHost.some(m => m.t === 'custom'), 'a different host is not owed the last game\'s words');

  console.log(failures ? `${failures} failure(s)` : 'ok');
  process.exit(failures ? 1 : 0);
})();
