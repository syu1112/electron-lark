'use strict';

if (window.larkDesktop?.platform === 'darwin') {
    let composing = false;
    window.addEventListener('compositionstart', () => { composing = true; }, true);
    window.addEventListener('compositionend', () => { composing = false; }, true);

    // Change the modifiers before the web editor handles the original trusted event.
    for (const type of ['keydown', 'keypress', 'keyup']) {
        window.addEventListener(type, event => {
            if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || composing) return;
            if (!(event.target instanceof Element) ||
                !event.target.closest('.lark__editor--simple.lark__editor--chat [contenteditable="true"]')) return;
            if (event.ctrlKey || event.altKey || event.shiftKey) return;
            if (event.metaKey && event.repeat) {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            const newline = !event.metaKey;
            const originalModifierState = event.getModifierState.bind(event);
            Object.defineProperties(event, {
                shiftKey: {value: newline},
                metaKey: {value: false},
                getModifierState: {value: key => key === 'Shift' ? newline : key === 'Meta' ? false : originalModifierState(key)}
            });
        }, true);
    }
}
