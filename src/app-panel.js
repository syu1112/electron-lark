'use strict';
for (const action of ['back', 'reload', 'close']) {
    document.getElementById(action).onclick = () => window.appPanel.action(action);
}
window.appPanel.onUpdate(state => {
    document.getElementById('back').hidden = !state.back;
    const nav = document.getElementById('apps');
    nav.replaceChildren();
    for (const app of state.apps) {
        const button = document.createElement('button');
        button.textContent = app.title;
        button.setAttribute('aria-selected', String(app.id === state.active));
        button.onclick = () => window.appPanel.action('select', app.id);
        nav.append(button);
    }
});
