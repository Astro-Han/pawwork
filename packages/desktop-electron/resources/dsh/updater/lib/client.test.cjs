'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The updater client is a single self-contained ModuleLoader bundle (the
// loader's require reaches only react and the primitives), so the seam is the
// plugin object itself: capture the factory through a fake bootstrap, drive
// apply() with a fake slot registry, and render components with a minimal
// createElement that returns plain trees to assert on.

const CLIENT_PATH = path.join(__dirname, 'client.js');

// createElement trees: { type, props: { ...props, children } }. String types
// are host elements; function types are components and get resolved by walk().
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
    }),
    useEffect: (callback) => { callback(); },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
  };
}

// Walk a tree, resolving function components one level at a time.
function* walk(node) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (typeof node !== 'object') return;
  let current = node;
  while (current && typeof current.type === 'function') {
    current = current.type(current.props);
  }
  if (current === null || current === undefined) return;
  yield current;
  yield* walk(current.props && current.props.children);
}

function rendered(node) {
  return [...walk(node)];
}

function texts(node) {
  return rendered(node)
    .flatMap((element) => {
      const children = element.props.children;
      return [children].flat(Infinity).filter((child) => typeof child === 'string');
    });
}

function loadPlugin({ bridge, lang = 'zh' } = {}) {
  let factory;
  const appendedStyles = [];
  const sandbox = {
    window: {},
    setTimeout,
    clearTimeout,
    document: {
      documentElement: { lang },
      head: { appendChild: (style) => appendedStyles.push(style) },
      createElement: () => ({ dataset: {} }),
      querySelector: () => null,
    },
  };
  sandbox.window = {
    pawworkUpdater: bridge,
    __ModuleLoader__: { load: (entry) => { factory = entry.factory; } },
  };
  vm.runInNewContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox);
  const react = fakeReact();
  const plugin = factory((name) => {
    if (name === 'react') return react;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Button: 'Button', IconDownloadOutline16: 'IconDownloadOutline16' };
    }
    throw new Error(`unexpected client dependency: ${name}`);
  });
  return { plugin, appendedStyles };
}

// apply() kicks off the store's first bridge read; settle it before rendering
// so components observe the state under test rather than the loading state.
async function applyPlugin(options) {
  const { plugin } = loadPlugin(options);
  const registered = [];
  const ctx = {
    slots: {
      inject: (key, callback) => callback(),
      register: (spec, component) => { registered.push({ spec, component }); },
    },
  };
  plugin.apply(ctx);
  await new Promise((resolve) => setImmediate(resolve));
  return { registered };
}

function bridgeWith(snapshot) {
  const calls = { check: 0, install: 0, openDownloadPage: 0 };
  return {
    calls,
    getState: async () => snapshot,
    check: async () => { calls.check += 1; },
    install: async () => { calls.install += 1; },
    openDownloadPage: () => { calls.openDownloadPage += 1; },
    subscribe: () => () => {},
  };
}

// A registered slot component always returns an element; 'renders nothing'
// means resolving its function components bottoms out at null.
function rendersNull(node) {
  return rendered(node).length === 0;
}

function componentFor(registered, slotName) {
  const entry = registered.find(({ spec }) => spec.name === slotName);
  assert.ok(entry, `expected a ${slotName} registration`);
  return entry;
}

test('host entry imports without browser globals and applies as a no-op', async () => {
  // The cordis loader imports the package main inside the DSH sidecar (plain
  // Node): a host entry that touches window at import time takes the whole
  // profile down, which is exactly how this plugin first failed to boot.
  const { apply } = await import('./index.js');
  assert.equal(typeof apply, 'function');
  apply();
});

test('registers the settings section, ready toast and sidebar indicator', async () => {
  const { registered } = await applyPlugin({ bridge: bridgeWith({ state: { status: 'none' }, progress: null, currentVersion: '1.0.0' }) });
  const names = registered.map(({ spec }) => spec.name).sort();
  assert.deepEqual(names, ['settings.section', 'shell.overlay', 'sidebar.footer.action']);
  const section = componentFor(registered, 'settings.section');
  assert.equal(section.spec.id, 'pawwork-update');
  assert.equal(typeof section.spec.label, 'function');
});

test('settings section reports the current version when up to date', async () => {
  const bridge = bridgeWith({ state: { status: 'none' }, progress: null, currentVersion: '2026.8.8' });
  const { registered } = await applyPlugin({ bridge });
  const section = componentFor(registered, 'settings.section');
  const tree = section.component({ close: () => {} });
  const text = texts(tree).join('\n');
  assert.match(text, /2026\.8\.8/);
  assert.match(text, /已是最新版本/);
});

test('check button asks the bridge for a check', async () => {
  const bridge = bridgeWith({ state: { status: 'none' }, progress: null, currentVersion: '1.0.0' });
  const { registered } = await applyPlugin({ bridge });
  const tree = componentFor(registered, 'settings.section').component({ close: () => {} });
  const buttons = rendered(tree).filter((element) => element.type === 'Button');
  const check = buttons.find((element) => JSON.stringify(element.props.children).includes('检查更新'));
  assert.ok(check, 'expected a check-for-updates button');
  check.props.onClick();
  assert.equal(bridge.calls.check, 1);
});

test('ready state offers restart-and-install in both the section and the toast', async () => {
  const bridge = bridgeWith({ state: { status: 'ready', version: '2026.8.9' }, progress: null, currentVersion: '2026.8.8' });
  const { registered } = await applyPlugin({ bridge });
  const sectionTree = componentFor(registered, 'settings.section').component({ close: () => {} });
  const toastTree = componentFor(registered, 'shell.overlay').component({});
  for (const tree of [sectionTree, toastTree]) {
    const buttons = rendered(tree).filter((element) => element.type === 'Button');
    const install = buttons.find((element) => element.props.variant === 'primary');
    assert.ok(install, 'expected a restart-and-install button');
    install.props.onClick();
  }
  assert.equal(bridge.calls.install, 2);
});

test('failed state offers retry and the download page', async () => {
  const bridge = bridgeWith({ state: { status: 'failed', reason: 'download', message: 'socket hangup' }, progress: null, currentVersion: '1.0.0' });
  const { registered } = await applyPlugin({ bridge });
  const tree = componentFor(registered, 'settings.section').component({ close: () => {} });
  const buttons = rendered(tree).filter((element) => element.type === 'Button');
  const retry = buttons.find((element) => JSON.stringify(element.props.children).includes('重试'));
  const page = buttons.find((element) => JSON.stringify(element.props.children).includes('下载页'));
  assert.ok(retry && page, 'expected retry and download-page buttons');
  retry.props.onClick();
  page.props.onClick();
  assert.equal(bridge.calls.check, 1);
  assert.equal(bridge.calls.openDownloadPage, 1);
});

test('toast is absent without a ready update and dismissible when ready', async () => {
  const idle = await applyPlugin({ bridge: bridgeWith({ state: { status: 'none' }, progress: null, currentVersion: '1.0.0' }) });
  assert.ok(rendersNull(componentFor(idle.registered, 'shell.overlay').component({})));

  const bridge = bridgeWith({ state: { status: 'ready', version: '9.9.9' }, progress: null, currentVersion: '1.0.0' });
  const { registered } = await applyPlugin({ bridge });
  const toast = componentFor(registered, 'shell.overlay');
  const tree = toast.component({});
  assert.ok(!rendersNull(tree));
  const later = rendered(tree)
    .filter((element) => element.type === 'Button')
    .find((element) => JSON.stringify(element.props.children).match(/稍后|Later/));
  assert.ok(later, 'expected a later button');
  later.props.onClick();
  assert.ok(rendersNull(toast.component({})));
});

test('sidebar indicator only appears for a ready update and resurfaces the toast', async () => {
  const quiet = await applyPlugin({ bridge: bridgeWith({ state: { status: 'downloading', version: '9.9.9' }, progress: 0.4, currentVersion: '1.0.0' }) });
  assert.ok(rendersNull(componentFor(quiet.registered, 'sidebar.footer.action').component({ wide: true })));

  const bridge = bridgeWith({ state: { status: 'ready', version: '9.9.9' }, progress: null, currentVersion: '1.0.0' });
  const { registered } = await applyPlugin({ bridge });
  const footer = componentFor(registered, 'sidebar.footer.action');
  const tree = footer.component({ wide: true });
  assert.ok(!rendersNull(tree));

  // Dismiss the toast, then resurface it from the indicator.
  const toast = componentFor(registered, 'shell.overlay');
  const later = rendered(toast.component({}))
    .filter((element) => element.type === 'Button')
    .find((element) => JSON.stringify(element.props.children).match(/稍后|Later/));
  later.props.onClick();
  assert.ok(rendersNull(toast.component({})));
  rendered(tree).find((element) => element.type === 'button').props.onClick();
  assert.ok(!rendersNull(toast.component({})));
});

test('a subscribed payload survives an earlier in-flight read resolving late', async () => {
  // The read started before the broadcast, so its answer is older state;
  // adopting it on settlement would clobber the newer subscribed snapshot.
  let subscriber;
  let resolveRead;
  const bridge = {
    calls: { check: 0, install: 0, openDownloadPage: 0 },
    getState: () => new Promise((resolve) => { resolveRead = resolve; }),
    check: async () => {},
    install: async () => {},
    openDownloadPage: () => {},
    subscribe: (listener) => { subscriber = listener; return () => {}; },
  };
  const { registered } = await applyPlugin({ bridge });
  subscriber({ state: { status: 'ready', version: '9.9.9' }, progress: null, currentVersion: '1.0.0' });
  resolveRead({ state: { status: 'none' }, progress: null, currentVersion: '1.0.0' });
  await new Promise((resolve) => setImmediate(resolve));
  const tree = componentFor(registered, 'settings.section').component({ close: () => {} });
  assert.match(texts(tree).join('\n'), /已就绪|is ready/);
});

test('recovers when the first state read lands before the main process is ready', async () => {
  // At client boot the DSH lifecycle in main may not be ready yet, so the
  // first getState rejects. The store must retry rather than latch
  // 'unavailable' — in dev no broadcast ever arrives to correct it.
  let attempts = 0;
  const bridge = {
    calls: { check: 0, install: 0, openDownloadPage: 0 },
    getState: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('DSH plugin requests require a ready product');
      return { state: { status: 'disabled' }, progress: null, currentVersion: '2026.8.8' };
    },
    check: async () => {},
    install: async () => {},
    openDownloadPage: () => {},
    subscribe: () => () => {},
  };
  const { plugin } = loadPlugin({ bridge });
  const registered = [];
  plugin.apply({ slots: { inject: (key, callback) => callback(), register: (spec, component) => registered.push({ spec, component }) } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const tree = componentFor(registered, 'settings.section').component({ close: () => {} });
  assert.ok(attempts >= 2, `expected a retry, got ${attempts} attempt(s)`);
  assert.match(texts(tree).join('\n'), /2026\.8\.8/);
});

test('settings section treats a gated-off updater as unavailable', async () => {
  const bridge = bridgeWith({ state: { status: 'disabled' }, progress: null, currentVersion: '1.0.0-dev' });
  const { registered } = await applyPlugin({ bridge });
  const tree = componentFor(registered, 'settings.section').component({ close: () => {} });
  const text = texts(tree).join('\n');
  assert.match(text, /不提供|unavailable/);
  assert.ok(rendered(tree).some((element) => element.type === 'Button'));
});

test('surfaces an honest unavailable state when the preload bridge is missing', async () => {
  const { registered } = await applyPlugin({ bridge: undefined });
  const tree = componentFor(registered, 'settings.section').component({ close: () => {} });
  assert.match(texts(tree).join('\n'), /不提供|unavailable/);
  // Without the bridge the download-page action would be a dead button.
  const page = rendered(tree).find((element) => element.type === 'Button' && JSON.stringify(element.props.children).match(/下载页|Download Page/));
  assert.equal(page.props.disabled, true);
  assert.ok(rendersNull(componentFor(registered, 'shell.overlay').component({})));
  assert.ok(rendersNull(componentFor(registered, 'sidebar.footer.action').component({ wide: false })));
});
