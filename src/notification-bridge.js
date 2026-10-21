'use strict';
(() => {
    const desktop = window.larkDesktop;
    if (!desktop) return;
    const NativeNotification = window.Notification;
    const notifications = new Map();
    const ids = new WeakMap();
    const handlers = new WeakMap();

    class newNotification extends EventTarget {
        constructor(title, options = {}) {
            super();
            this.title = String(title);
            for (const key of ['body', 'dir', 'lang', 'tag', 'icon', 'image', 'badge', 'vibrate', 'timestamp', 'renotify', 'requireInteraction', 'data', 'silent', 'actions', 'channelId']) {
                this[key] = options[key];
            }
            const id = crypto.randomUUID();
            ids.set(this, id);
            handlers.set(this, {});
            notifications.set(id, this);
            try {
                desktop.notify(this.title, options, id);
            } catch (error) {
                notifications.delete(id);
                return new NativeNotification(title, options);
            }
        }
        close() {
            const id = ids.get(this);
            if (!notifications.delete(id)) return;
            desktop.closeNotification(id);
            this.dispatchEvent(new Event('close'));
        }
    }
    for (const type of ['click', 'show', 'close', 'error']) {
        Object.defineProperty(newNotification.prototype, `on${type}`, {
            get() { return handlers.get(this)[type] || null; },
            set(callback) {
                const previous = handlers.get(this)[type];
                if (previous) this.removeEventListener(type, previous);
                handlers.get(this)[type] = typeof callback === 'function' ? callback : null;
                if (handlers.get(this)[type]) this.addEventListener(type, callback);
            }
        });
    }
    newNotification.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);
    Object.defineProperty(newNotification, 'permission', {get: () => NativeNotification.permission});
    desktop.onNotificationEvent((id, type) => {
        const notification = notifications.get(id);
        if (!notification || !['click', 'show', 'close', 'error'].includes(type)) return;
        if (type === 'click' && notification.channelId != null) {
            for (const element of document.querySelectorAll('[data-feed-id]')) {
                if (element.getAttribute('data-feed-id') === String(notification.channelId)) {
                    element.click();
                    break;
                }
            }
        }
        notification.dispatchEvent(new Event(type));
        if (type === 'close' || type === 'error') notifications.delete(id);
    });
    window.Notification = newNotification;
})();
