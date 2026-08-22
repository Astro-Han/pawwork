'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function loadIdentity() {
	return import(pathToFileURL(path.join(__dirname, 'index.js')).href);
}

test('waits for the system-prompt service and nothing else', async () => {
	const { inject } = await loadIdentity();
	assert.deepEqual(inject, ['systemPrompt']);
});

test('registers exactly one PawWork identity section in the identity band', async () => {
	const { apply, PAWWORK_IDENTITY_SECTION } = await loadIdentity();
	const registered = [];
	apply({ systemPrompt: { section: (section) => registered.push(section) } });

	assert.deepEqual(registered, [PAWWORK_IDENTITY_SECTION]);
	assert.equal(PAWWORK_IDENTITY_SECTION.name, 'pawwork:identity');
	// Identity band: after the harness identity (-100), before the persona (0).
	assert.ok(PAWWORK_IDENTITY_SECTION.order > -100 && PAWWORK_IDENTITY_SECTION.order < 0);
});

test('the identity text names PawWork and its DeepSeek Harness base', async () => {
	const { PAWWORK_IDENTITY_SECTION } = await loadIdentity();
	assert.match(PAWWORK_IDENTITY_SECTION.text, /PawWork/);
	assert.match(PAWWORK_IDENTITY_SECTION.text, /爪印/);
	assert.match(PAWWORK_IDENTITY_SECTION.text, /DeepSeek Harness/);
	// Section text is interpolated strictly: a stray {{…}} group throws at
	// render. The identity is static prose and must stay free of them.
	assert.ok(!PAWWORK_IDENTITY_SECTION.text.includes('{{'));
});
