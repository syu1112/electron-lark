'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page() {
    let notifyEvent;
    const sent = [];
    const original = class NativeNotification {};
    original.permission = 'granted';
    original.requestPermission = async () => 'granted';
    const channel = {getAttribute: () => 'chat-7', click() { state.chat = 'chat-7'; }};
    const state = {chat: 'other', message: null};
    const window = {Notification: original, larkDesktop: {
        notify(title, opt, id) { sent.push({title, opt, id}); },
        onNotificationEvent(callback) { notifyEvent = callback; },
        closeNotification(id) { sent.push({close: id}); }
    }};
    const context = vm.createContext({window, EventTarget, Event, crypto: require('node:crypto').webcrypto,
        document: {querySelectorAll: () => [channel]}});
    const source = fs.readFileSync(require('node:path').join(__dirname, '../src/notification-bridge.js'), 'utf8');
    vm.runInContext(source, context);
    return {window, sent, state, click(id) { if (notifyEvent) notifyEvent(id, 'click'); }, emit(id, type) { if (notifyEvent) notifyEvent(id, type); }};
}

test('native click invokes the original page callback with its notification and message context', () => {
    const p = page();
    const data = {chat: 'chat-7', message: 'message-23'};
    const notification = new p.window.Notification('Unrelated title', {body: 'Unrelated body', channelId: 'chat-7', data});
    let received;
    notification.onclick = function(event) {
        received = {self: this, target: event.target, type: event.type};
        p.state.chat = this.data.chat;
        p.state.message = data.message;
    };
    p.click(p.sent[0].id);
    assert.deepEqual(p.state, {chat: 'chat-7', message: 'message-23'});
    assert.equal(received.self, notification);
    assert.equal(received.target, notification);
    assert.equal(received.type, 'click');
});

test('each notification retains its event listeners even with identical message text', () => {
    const p = page();
    const first = new p.window.Notification('Same', {body: 'Same', data: {message: 'first'}});
    const second = new p.window.Notification('Same', {body: 'Same', data: {message: 'second'}});
    const received = [];
    first.addEventListener('click', function() { received.push(this.data.message); });
    second.addEventListener('click', function() { received.push(this.data.message); });
    assert.notEqual(p.sent[0].id, p.sent[1].id);
    p.click(p.sent[1].id);
    p.click(p.sent[0].id);
    assert.deepEqual(received, ['second', 'first']);
});

test('notification without a page handler can still select a matching channel without evaluating message text', () => {
    const p = page();
    new p.window.Notification('throw Error("title evaluated")', {body: 'throw Error("body evaluated")', channelId: 'chat-7'});
    p.click(p.sent[0].id);
    assert.equal(p.state.chat, 'chat-7');
});

test('closing a page notification dismisses the native notification and retains its close callback', () => {
    const p = page();
    const notification = new p.window.Notification('Close', {body: 'Dismiss'});
    const id = p.sent[0].id;
    let closed = 0;
    notification.onclose = () => { closed++; };
    notification.close();
    assert.deepEqual(p.sent[1], {close: id});
    p.emit(id, 'close');
    assert.equal(closed, 1);
    p.click(id);
    assert.equal(closed, 1);
});

test('a click from a previous document cannot target an identically worded notification after reload', () => {
    const previous = page();
    new previous.window.Notification('Same title', {body: 'Same body'});
    const current = page();
    const notification = new current.window.Notification('Same title', {body: 'Same body'});
    let clicked = 0;
    notification.onclick = () => { clicked++; };
    current.click(previous.sent[0].id);
    assert.equal(clicked, 0);
    current.click(current.sent[0].id);
    assert.equal(clicked, 1);
});
